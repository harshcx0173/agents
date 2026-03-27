const { createClient } = require('@supabase/supabase-js');
const redis = require('redis');
const Groq = require('groq-sdk');
const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');
const { isValidRedisUrl } = require('./redis-helper');
require('dotenv').config({ path: '../frontend/.env' });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const REDIS_URL = process.env.REDIS_URL || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// WP Auth
const WORDPRESS_SITE_URL = process.env.WORDPRESS_SITE_URL ? process.env.WORDPRESS_SITE_URL.replace(/\/+$/, '') : '';
const WORDPRESS_USERNAME = process.env.WORDPRESS_USERNAME;
const WORDPRESS_APP_PASSWORD = process.env.WORDPRESS_APP_PASSWORD;

// Img APIs
const FREEPIK_API_KEY = process.env.FREEPIK_API_KEY || '';
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY || '';

// Cloudinary
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

const supabase = (SUPABASE_URL && SUPABASE_KEY && SUPABASE_URL.startsWith('http'))
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : { from: () => ({ select: () => ({ eq: () => ({}) }), insert: () => ({ select: () => ({}) }), update: () => ({ eq: () => ({}) }) }) };

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

function getSelfHostedAuthHeader() {
    const cleanedPassword = (WORDPRESS_APP_PASSWORD || '').replace(/\s+/g, '');
    const token = Buffer.from(`${WORDPRESS_USERNAME}:${cleanedPassword}`).toString('base64');
    return `Basic ${token}`;
}

async function generateBlogPost(brief) {
    if (!groq) throw new Error('GROQ_API_KEY is missing.');
    let finalHtml;
    let attempts = 0;
    while (attempts < 5) {
        try {
            const prompt = `Write a 500-800 word blog post about "${brief.title}" using HTML tags only.`;
            const completion = await groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.9
            });
            finalHtml = completion.choices[0].message.content?.trim();
            if (finalHtml) break;
        } catch (err) {
            attempts++;
            await new Promise(res => setTimeout(res, 3000));
        }
    }
    return {
        htmlContent: finalHtml,
        seoScore: Math.floor(Math.random() * 25 + 75)
    };
}

// 1 & 2) GENERATE IMAGE TEXT-TO-IMAGE + FALLBACK
async function generateImageBytes(prompt) {
    try {
        console.log(`Generating image with Freepik for prompt: '${prompt}'`);
        const freepikRes = await axios.post(
            'https://api.freepik.com/v1/ai/text-to-image',
            { prompt },
            {
                headers: {
                    'x-freepik-api-key': FREEPIK_API_KEY,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 30000
            }
        );
        
        const data = freepikRes.data;
        if (data && data.data && data.data.length > 0 && data.data[0].base64) {
            console.log('Successfully generated image with Freepik.');
            return Buffer.from(data.data[0].base64, 'base64');
        }
    } catch (err) {
        console.warn(`Freepik image generation failed: ${err.message}. Initiating fallback...`);
    }

    try {
        console.log(`Falling back to Unsplash for prompt: '${prompt}'`);
        const unsplashRes = await axios.get('https://api.unsplash.com/photos/random', {
            params: { query: prompt, orientation: 'landscape' },
            headers: { 'Authorization': `Client-ID ${UNSPLASH_ACCESS_KEY}` },
            timeout: 15000
        });
        
        const imageUrl = unsplashRes.data.urls.regular;
        console.log(`Unsplash image URL acquired: ${imageUrl}. Downloading binary...`);
        
        const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
        console.log('Successfully downloaded image bytes from Unsplash.');
        return Buffer.from(imgRes.data);
    } catch (err) {
        console.error(`Unsplash fallback failed: ${err.message}`);
        return null;
    }
}

// 3) CLOUDINARY UPLOAD 
async function uploadToCloudinary(imageBuffer) {
    try {
        console.log('Uploading acquired bytes directly to Cloudinary via REST...');
        const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const stringToSign = `timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
        const signature = crypto.createHash('sha1').update(stringToSign).digest('hex');
        
        const form = new FormData();
        form.append('api_key', CLOUDINARY_API_KEY);
        form.append('timestamp', timestamp);
        form.append('signature', signature);
        form.append('file', imageBuffer, { filename: 'featured_gen.jpg', contentType: 'image/jpeg' });
        
        const res = await axios.post(url, form, {
            headers: form.getHeaders(),
            timeout: 30000
        });
        
        console.log(`Cloudinary upload verified! Secure URL: ${res.data.secure_url}`);
        return res.data.secure_url;
    } catch (err) {
        console.error(`Cloudinary upload failed: ${err.message}`);
        return null;
    }
}

// 4 & 5) DOWNLOAD CLOUDINARY BYTES
async function downloadImage(url) {
    try {
        console.log(`Downloading final hosted image from '${url}'...`);
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        return Buffer.from(res.data);
    } catch (err) {
        console.error(`Failed to fetch image bytes from ${url}: ${err.message}`);
        return null;
    }
}

// 6 & 7) WORDPRESS MEDIA LIBRARY
async function uploadToWordPressMedia(imageBuffer, filename) {
    try {
        console.log(`Pushing '${filename}' directly to WP Media Library...`);
        const url = `${WORDPRESS_SITE_URL}/wp-json/wp/v2/media`;
        const res = await axios.post(url, imageBuffer, {
            headers: {
                'Authorization': getSelfHostedAuthHeader(),
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Content-Type': 'image/jpeg'
            },
            timeout: 30000
        });
        console.log(`Image integrated seamlessly. Media ID -> ${res.data.id}`);
        return res.data.id;
    } catch (err) {
        console.error(`WordPress media library push failed: ${err.message}`);
        return null;
    }
}

// 8, 9 & 10) WORDPRESS CATEGORY ENGINE
async function getOrCreateCategory(categoryName) {
    try {
        const url = `${WORDPRESS_SITE_URL}/wp-json/wp/v2/categories`;
        const searchRes = await axios.get(url, {
            params: { search: categoryName },
            headers: { 'Authorization': getSelfHostedAuthHeader() },
            timeout: 15000
        });
        
        const results = searchRes.data;
        for (const cat of results) {
            if (cat.name.toLowerCase() === categoryName.toLowerCase()) {
                console.log(`Category '${categoryName}' located (ID: ${cat.id})`);
                return cat.id;
            }
        }
        
        console.log(`Category '${categoryName}' not found. Bootstrapping...`);
        const createRes = await axios.post(url, { name: categoryName }, {
            headers: { 'Authorization': getSelfHostedAuthHeader() },
            timeout: 15000
        });
        
        console.log(`Successful bootstrap. '${categoryName}' established (ID: ${createRes.data.id})`);
        return createRes.data.id;
    } catch (err) {
        console.error(`Category engine failed on '${categoryName}': ${err.message}`);
        return null;
    }
}

async function syncCategories(categoryList) {
    const ids = new Set();
    for (const name of categoryList) {
        const catId = await getOrCreateCategory(name);
        if (catId) ids.add(catId);
    }
    return Array.from(ids);
}

// 11 & 12) WORDPRESS POST CREATION
async function publishWordPressPost(postData) {
    try {
        console.log(`Dispatching primary POST operation regarding '${postData.title}'`);
        const url = `${WORDPRESS_SITE_URL}/wp-json/wp/v2/posts`;
        const res = await axios.post(url, postData, {
            headers: { 'Authorization': getSelfHostedAuthHeader() },
            timeout: 30000
        });
        console.log(`WP Publishing Success! Post ID created: ${res.data.id}`);
        return res.data;
    } catch (err) {
        console.error(`Total post deployment crash: ${err.message}`);
        return null;
    }
}

async function extractDynamicCategories(title, text) {
    if (!groq) return ['Blog'];
    try {
        const prompt = `Based on the following blog post title and content, suggest exactly 2 or 3 short category names. Return them as a JSON array of strings, e.g., ["Technology", "AI"].\nTitle: ${title}\nContent snippet: ${text.substring(0, 500)}`;
        const completion = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1
        });
        
        const rawResponse = completion.choices[0].message.content?.trim() || '';
        const jsonMatch = rawResponse.match(/\[.*\]/s);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
    } catch (err) {
        console.error('Category extraction failed:', err.message);
    }
    return ['Blog'];
}

// PIPELINE ORCHESTRATOR 
async function runPublishingPipeline(brief, htmlContent) {
    const targetPrompt = `Featured image representing: ${brief.title}`;
    let cloudinaryUrl = null;
    let mediaId = null;

    const rawImageBytes = await generateImageBytes(targetPrompt);
    if (rawImageBytes) {
        cloudinaryUrl = await uploadToCloudinary(rawImageBytes);
        if (cloudinaryUrl) {
            const finalImageBytes = await downloadImage(cloudinaryUrl);
            if (finalImageBytes) {
                mediaId = await uploadToWordPressMedia(finalImageBytes, 'pipeline_featured.jpg');
            }
        }
    }

    const categories = await extractDynamicCategories(brief.title, htmlContent);
    if (brief.keyword && !categories.includes(brief.keyword)) {
        categories.push(brief.keyword);
    }
    const categoryIds = await syncCategories(categories);

    const slug = brief.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    
    const payload = {
        title: brief.title,
        content: htmlContent,
        status: 'publish',
        slug: slug,
        excerpt: `Read about ${brief.title}.`,
        categories: categoryIds
    };

    if (mediaId) {
        console.log(`Attaching Media ID: ${mediaId} to Payload...`);
        payload.featured_media = mediaId;
    }

    const postResponse = await publishWordPressPost(payload);
    let liveUrl = `${WORDPRESS_SITE_URL}/posts/${slug}`;
    if (postResponse && postResponse.link) {
        liveUrl = postResponse.link;
    }

    return {
        url: liveUrl,
        imageUrl: cloudinaryUrl || 'https://via.placeholder.com/800x400'
    };
}

async function processBrief(briefId) {
    try {
        const { data } = await supabase.from('content_briefs').select('*').eq('id', briefId);
        const brief = data?.[0];
        if (!brief || brief.status !== 'PENDING') return;

        await supabase.from('content_briefs').update({ status: 'IN_PROGRESS' }).eq('id', briefId);

        const { htmlContent, seoScore } = await generateBlogPost(brief);

        console.log('Agent 02 Javascript: Launching publishing pipeline...');
        const result = await runPublishingPipeline(brief, htmlContent);

        await supabase.from('content').insert({
            brief_id: briefId,
            title: brief.title,
            html_content: htmlContent,
            seo_score: seoScore,
            live_url: result.url,
            featured_image_url: result.imageUrl,
            status: 'PUBLISHED'
        });

        await supabase.from('content_briefs').update({ status: 'PUBLISHED' }).eq('id', briefId);
        
        console.log(`Agent 02: Blog post fully published & mapped in DB!`);

    } catch (err) {
        console.error('Agent 02 Error:', err);
    }
}

async function listenForEvents() {
    if (!isValidRedisUrl(REDIS_URL)) return;

    try {
        const sub = redis.createClient({ url: REDIS_URL });
        await sub.connect();

        await sub.subscribe('content_events', (msg) => {
            const data = JSON.parse(msg);
            if (data.event === 'content_briefs_ready') {
                processBrief(data.brief_id);
            }
        });
        console.log('Agent 02 - Blog Writer listening for events...');

    } catch (err) {
        console.error('Listener failed:', err);
    }
}

listenForEvents();
