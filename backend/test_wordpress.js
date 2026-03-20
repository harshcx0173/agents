require('dotenv').config({ path: '../frontend/.env' });

const WP_COM_SITE = process.env.WP_COM_SITE || 'myaiagentblog09.wordpress.com';
const WP_COM_TOKEN = process.env.WP_COM_TOKEN ? decodeURIComponent(process.env.WP_COM_TOKEN) : null;

const WORDPRESS_SITE_URL = process.env.WORDPRESS_SITE_URL;
const WORDPRESS_USERNAME = process.env.WORDPRESS_USERNAME;
const WORDPRESS_APP_PASSWORD = process.env.WORDPRESS_APP_PASSWORD;

function normalizeSiteUrl(url) {
    return url ? url.replace(/\/+$/, '') : '';
}

function getSelfHostedAuthHeader() {
    const cleanedPassword = (WORDPRESS_APP_PASSWORD || '').replace(/\s+/g, '');
    const token = Buffer.from(`${WORDPRESS_USERNAME}:${cleanedPassword}`).toString('base64');
    return `Basic ${token}`;
}

function isSelfHostedConfigured() {
    return Boolean(WORDPRESS_SITE_URL && WORDPRESS_USERNAME && WORDPRESS_APP_PASSWORD);
}

async function testWordPressCom() {
    if (isSelfHostedConfigured()) {
        const baseUrl = normalizeSiteUrl(WORDPRESS_SITE_URL);
        console.log('Testing self-hosted WordPress API...');
        console.log('Site:', baseUrl);
        console.log('Username:', WORDPRESS_USERNAME ? 'SET ???' : 'MISSING ???');
        console.log('App Password:', WORDPRESS_APP_PASSWORD ? 'SET ???' : 'MISSING ???');

        const endpoint = `${baseUrl}/wp-json/wp/v2/posts`;

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': getSelfHostedAuthHeader(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    title: '???? AI Test Post - ' + new Date().toLocaleString(),
                    content: '<h2>This is AI Generated Content</h2><p>This post was automatically published by the AI Content Agent. The three-agent system is working correctly!</p><p>Agent 01 (Strategist) ??? Agent 02 (Writer) ??? Agent 03 (Auditor)</p>',
                    status: 'publish'
                })
            });

            const data = await response.json();

            if (data.id) {
                console.log('SUCCESS! Post published to self-hosted WordPress!');
                console.log('Post ID:', data.id);
                console.log('Live URL:', data.link);
            } else {
                console.log('FAILED. Response:');
                console.log(JSON.stringify(data, null, 2));
            }
        } catch (err) {
            console.error('Error:', err.message);
        }
        return;
    }

    console.log('Testing WordPress.com API...');
    console.log('Site:', WP_COM_SITE);
    console.log('Token:', WP_COM_TOKEN ? 'SET ???' : 'MISSING ???');

    const endpoint = `https://public-api.wordpress.com/rest/v1.1/sites/${WP_COM_SITE}/posts/new`;

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${WP_COM_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                title: '???? AI Test Post - ' + new Date().toLocaleString(),
                content: '<h2>This is AI Generated Content</h2><p>This post was automatically published by the AI Content Agent. The three-agent system is working correctly!</p><p>Agent 01 (Strategist) ??? Agent 02 (Writer) ??? Agent 03 (Auditor)</p>',
                status: 'publish'
            })
        });

        const data = await response.json();

        if (data.ID) {
            console.log('SUCCESS! Post published to WordPress.com!');
            console.log('Post ID:', data.ID);
            console.log('Live URL:', data.URL);
            console.log('Visit your blog: https://' + WP_COM_SITE);
        } else {
            console.log('FAILED. Response:');
            console.log(JSON.stringify(data, null, 2));
        }
    } catch (err) {
        console.error('Error:', err.message);
    }
}

testWordPressCom();
