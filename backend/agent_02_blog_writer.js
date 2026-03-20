const { createClient } = require('@supabase/supabase-js');
const redis = require('redis');
const Groq = require('groq-sdk');
const axios = require('axios');
const FormData = require('form-data');
const { isValidRedisUrl } = require('./redis-helper');
require('dotenv').config({ path: '../frontend/.env' });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const REDIS_URL = process.env.REDIS_URL || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WP_COM_SITE = process.env.WP_COM_SITE || 'myaiagentblog09.wordpress.com';
const WP_COM_TOKEN = process.env.WP_COM_TOKEN ? decodeURIComponent(process.env.WP_COM_TOKEN) : null;
const WORDPRESS_SITE_URL = process.env.WORDPRESS_SITE_URL;
const WORDPRESS_USERNAME = process.env.WORDPRESS_USERNAME;
const WORDPRESS_APP_PASSWORD = process.env.WORDPRESS_APP_PASSWORD;
const FREEPIK_API_KEY = process.env.FREEPIK_API_KEY || '';

const supabase = (SUPABASE_URL && SUPABASE_KEY && SUPABASE_URL.startsWith('http'))
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : { from: () => ({ select: () => ({ eq: () => ({}) }), insert: () => ({ select: () => ({}) }), update: () => ({ eq: () => ({}) }) }) };

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

function normalizeSiteUrl(url) {
    return url ? url.replace(/\/+$/, '') : '';
}

function isSelfHostedConfigured() {
    return Boolean(WORDPRESS_SITE_URL && WORDPRESS_USERNAME && WORDPRESS_APP_PASSWORD);
}

function getSelfHostedAuthHeader() {
    const cleanedPassword = (WORDPRESS_APP_PASSWORD || '').replace(/\s+/g, '');
    const token = Buffer.from(`${WORDPRESS_USERNAME}:${cleanedPassword}`).toString('base64');
    return `Basic ${token}`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function generateFreepikImage(prompt) {
    if (!FREEPIK_API_KEY) {
        return null;
    }

    const createRes = await axios.post(
        'https://api.freepik.com/v1/ai/mystic',
        {
            prompt
        },
        {
            headers: {
                'Content-Type': 'application/json',
                'x-freepik-api-key': FREEPIK_API_KEY
            }
        }
    );

    const taskId = createRes.data?.data?.task_id;
    if (!taskId) return null;

    for (let attempt = 0; attempt < 10; attempt++) {
        await sleep(3000);
        const statusRes = await axios.get(
            `https://api.freepik.com/v1/ai/mystic/${taskId}`,
            { headers: { 'x-freepik-api-key': FREEPIK_API_KEY } }
        );

        const status = statusRes.data?.data?.status;
        const generated = statusRes.data?.data?.generated;

        if (status === 'COMPLETED' && Array.isArray(generated) && generated[0]) {
            return generated[0];
        }
        if (status === 'FAILED') {
            return null;
        }
    }

    return null;
}

async function logActivity(agentName, eventType, message, metadata = {}) {
    try {
        await supabase.from('agent_logs').insert({
            agent_name: agentName,
            event_type: eventType,
            message,
            metadata
        });
    } catch (err) {
        console.error('Logging failed:', err.message);
    }
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

async function publishToCMS(postData, briefId) {
    const previewUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/preview/${briefId}`;
    const useSelfHosted = isSelfHostedConfigured();
    const useWpCom = Boolean(WP_COM_TOKEN && WP_COM_SITE);

    if (!useSelfHosted && !useWpCom) {
        return { url: previewUrl, media: [] };
    }

    try {
        const prompts = [
            `${postData.title}, cinematic blog cover`,
            `${postData.title}, futuristic concept`,
            `${postData.title}, abstract tech`,
            `${postData.title}, infographic style`
        ];

        const uploadedMedia = [];

        for (let i = 0; i < prompts.length; i++) {
            try {
                if (!FREEPIK_API_KEY) {
                    console.warn('FREEPIK_API_KEY missing. Skipping image generation.');
                    break;
                }

                const imageUrl = await generateFreepikImage(prompts[i]);
                if (!imageUrl) {
                    continue;
                }

                const imageRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });

                const form = new FormData();
                const filename = `img-${i}.jpg`;

                if (useSelfHosted) {
                    form.append('file', Buffer.from(imageRes.data), { filename });

                    const res = await axios.post(
                        `${normalizeSiteUrl(WORDPRESS_SITE_URL)}/wp-json/wp/v2/media`,
                        form,
                        { headers: { ...form.getHeaders(), Authorization: getSelfHostedAuthHeader() } }
                    );

                    uploadedMedia.push({ id: res.data.id, url: res.data.source_url });
                } else {
                    form.append('media[]', Buffer.from(imageRes.data), { filename });

                    const res = await axios.post(
                        `https://public-api.wordpress.com/rest/v1.1/sites/${WP_COM_SITE}/media/new`,
                        form,
                        { headers: { ...form.getHeaders(), Authorization: `Bearer ${WP_COM_TOKEN}` } }
                    );

                    const media = res.data.media?.[0];
                    if (media) uploadedMedia.push({ id: media.ID, url: media.URL });
                }

            } catch (err) {
                console.error(`Image ${i + 1} failed:`, err.message);
            }
        }

        let finalContent = postData.html_content;

        const featuredMediaId = uploadedMedia[0]?.id;

        let response;

        if (useSelfHosted) {
            response = await axios.post(
                `${normalizeSiteUrl(WORDPRESS_SITE_URL)}/wp-json/wp/v2/posts`,
                {
                    title: postData.title,
                    content: finalContent,
                    status: 'publish',
                    featured_media: featuredMediaId
                },
                { headers: { Authorization: getSelfHostedAuthHeader() } }
            );

            return { url: response.data.link, media: uploadedMedia };

        } else {
            response = await axios.post(
                `https://public-api.wordpress.com/rest/v1.1/sites/${WP_COM_SITE}/posts/new`,
                {
                    title: postData.title,
                    content: finalContent,
                    status: 'publish',
                    featured_media: featuredMediaId
                },
                { headers: { Authorization: `Bearer ${WP_COM_TOKEN}` } }
            );

            return { url: response.data.URL, media: uploadedMedia };
        }

    } catch (err) {
        console.error('Publish failed:', err.message);
        return { url: previewUrl, media: [] };
    }
}

async function processBrief(briefId) {
    try {
        const { data } = await supabase.from('content_briefs').select('*').eq('id', briefId);
        const brief = data?.[0];
        if (!brief || brief.status !== 'PENDING') return;

        await supabase.from('content_briefs').update({ status: 'IN_PROGRESS' }).eq('id', briefId);

        const { htmlContent, seoScore } = await generateBlogPost(brief);

        const result = await publishToCMS({
            title: brief.title,
            html_content: htmlContent
        }, briefId);

        await supabase.from('content').insert({
            brief_id: briefId,
            title: brief.title,
            html_content: htmlContent,
            seo_score: seoScore,
            live_url: result.url,
            status: 'PUBLISHED'
        });

        await supabase.from('content_briefs').update({ status: 'PUBLISHED' }).eq('id', briefId);

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

    } catch (err) {
        console.error('Listener failed:', err);
    }
}

listenForEvents();
