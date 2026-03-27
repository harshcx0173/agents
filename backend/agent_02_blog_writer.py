import os
import time
import json
import base64
import hashlib
import asyncio
import logging
from typing import List, Optional

import httpx
import redis
from supabase import create_client, Client
import google.generativeai as genai

# Setup Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Environment variables
SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://localhost:8000")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "dummy_key")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")

# Pipeline API Keys
FREEPIK_API_KEY = os.environ.get("FREEPIK_API_KEY")
UNSPLASH_ACCESS_KEY = os.environ.get("UNSPLASH_ACCESS_KEY")

CLOUDINARY_CLOUD_NAME = os.environ.get("CLOUDINARY_CLOUD_NAME")
CLOUDINARY_API_KEY = os.environ.get("CLOUDINARY_API_KEY")
CLOUDINARY_API_SECRET = os.environ.get("CLOUDINARY_API_SECRET")

WP_URL = os.environ.get("WP_URL", "").rstrip("/")
WP_USER = os.environ.get("WP_USER")
WP_APP_PASSWORD = os.environ.get("WP_APP_PASSWORD")

# Initialize clients
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
redis_client = redis.Redis.from_url(REDIS_URL)

if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
# llm_model = genai.GenerativeModel('gemini-2.5-flash')

def generate_blog_post(brief):
    """
    Simulate generating a 1500-2500 word blog post using Claude/GPT.
    Includes SEO formatting, internal linking, FAQ schema.
    """
    logger.info(f"Agent 02: Generating content for brief: {brief['title']}...")
    html_content = f"<h1>{brief['title']}</h1>\n<p>This is a complete 2000-word post with optimized H2s and FAQs.</p>"
    seo_score = 92
    return html_content, seo_score

# -------------------------------------------------------------------------
# ASYNC PIPELINE FUNCTIONS (Freepik -> Unsplash -> Cloudinary -> WP)
# -------------------------------------------------------------------------
async def generate_image_bytes(client: httpx.AsyncClient, prompt: str) -> Optional[bytes]:
    try:
        logger.info(f"Generating image with Freepik for prompt: '{prompt}'")
        freepik_url = "https://api.freepik.com/v1/ai/text-to-image"
        headers = {
            "x-freepik-api-key": FREEPIK_API_KEY,
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
        payload = {"prompt": prompt}
        response = await client.post(freepik_url, headers=headers, json=payload, timeout=30.0)
        response.raise_for_status()
        data = response.json()
        if "data" in data and len(data["data"]) > 0 and "base64" in data["data"][0]:
            return base64.b64decode(data["data"][0]["base64"])
    except Exception as e:
        logger.warning(f"Freepik image generation failed: {e}. Initiating fallback...")
        
    try:
        logger.info(f"Falling back to Unsplash for prompt: '{prompt}'")
        unsplash_url = "https://api.unsplash.com/photos/random"
        headers = {"Authorization": f"Client-ID {UNSPLASH_ACCESS_KEY}"}
        params = {"query": prompt, "orientation": "landscape"}
        response = await client.get(unsplash_url, headers=headers, params=params, timeout=15.0)
        response.raise_for_status()
        image_url = response.json()["urls"]["regular"]
        
        img_response = await client.get(image_url, timeout=15.0)
        img_response.raise_for_status()
        return img_response.content
    except Exception as e:
        logger.error(f"Unsplash fallback failed: {e}")
        return None

async def upload_to_cloudinary(client: httpx.AsyncClient, image_bytes: bytes) -> Optional[str]:
    try:
        logger.info("Uploading image to Cloudinary...")
        url = f"https://api.cloudinary.com/v1_1/{CLOUDINARY_CLOUD_NAME}/image/upload"
        timestamp = str(int(time.time()))
        string_to_sign = f"timestamp={timestamp}{CLOUDINARY_API_SECRET}"
        signature = hashlib.sha1(string_to_sign.encode("utf-8")).hexdigest()
        data = {
            "api_key": CLOUDINARY_API_KEY,
            "timestamp": timestamp,
            "signature": signature
        }
        files = {"file": ("featured_gen.jpg", image_bytes, "image/jpeg")}
        response = await client.post(url, data=data, files=files, timeout=30.0)
        response.raise_for_status()
        return response.json().get("secure_url")
    except Exception as e:
        logger.error(f"Cloudinary upload failed: {e}")
        return None

async def download_image(client: httpx.AsyncClient, url: str) -> Optional[bytes]:
    try:
        logger.info(f"Downloading Cloudinary image from {url}...")
        response = await client.get(url, timeout=15.0)
        response.raise_for_status()
        return response.content
    except Exception as e:
        logger.error(f"Failed to fetch image bytes from {url}: {e}")
        return None

async def upload_to_wordpress_media(client: httpx.AsyncClient, image_bytes: bytes, filename: str) -> Optional[int]:
    try:
        logger.info(f"Uploading generic binary to WP Media as '{filename}'...")
        media_url = f"{WP_URL}/wp-json/wp/v2/media"
        headers = {
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Type": "image/jpeg"
        }
        auth = (WP_USER, WP_APP_PASSWORD)
        response = await client.post(media_url, headers=headers, content=image_bytes, auth=auth, timeout=30.0)
        response.raise_for_status()
        return response.json().get("id")
    except Exception as e:
        logger.error(f"WordPress media library push failed: {e}")
        return None

async def get_or_create_category(client: httpx.AsyncClient, category_name: str) -> Optional[int]:
    try:
        cat_url = f"{WP_URL}/wp-json/wp/v2/categories"
        auth = (WP_USER, WP_APP_PASSWORD)
        search_res = await client.get(cat_url, params={"search": category_name}, auth=auth, timeout=15.0)
        search_res.raise_for_status()
        for cat in search_res.json():
            if cat.get("name", "").lower() == category_name.lower():
                return cat.get("id")
                
        create_res = await client.post(cat_url, json={"name": category_name}, auth=auth, timeout=15.0)
        create_res.raise_for_status()
        return create_res.json().get("id")
    except Exception as e:
        logger.error(f"Category engine failed on '{category_name}': {e}")
        return None

async def sync_categories(client: httpx.AsyncClient, category_list: List[str]) -> List[int]:
    ids = set()
    for name in category_list:
        cat_id = await get_or_create_category(client, name)
        if cat_id:
            ids.add(cat_id)
    return list(ids)

async def publish_wordpress_post(client: httpx.AsyncClient, post_data: dict) -> Optional[dict]:
    try:
        logger.info(f"Publishing definitive post: {post_data.get('title')}")
        post_url = f"{WP_URL}/wp-json/wp/v2/posts"
        auth = (WP_USER, WP_APP_PASSWORD)
        response = await client.post(post_url, json=post_data, auth=auth, timeout=30.0)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        logger.error(f"Total post deployment crash: {e}")
        return None

async def run_publishing_pipeline(brief: dict, html_content: str) -> dict:
    """Orchestrator for WP Pipeline Flow"""
    async with httpx.AsyncClient() as client:
        # Prompt for featured image
        target_prompt = f"Featured image representing: {brief['title']}"
        raw_image_bytes = await generate_image_bytes(client, target_prompt)
        
        cloudinary_url = None
        media_id = None
        
        # Follow storage chain
        if raw_image_bytes:
            cloudinary_url = await upload_to_cloudinary(client, raw_image_bytes)
            if cloudinary_url:
                final_image_bytes = await download_image(client, cloudinary_url)
                if final_image_bytes:
                    media_id = await upload_to_wordpress_media(client, final_image_bytes, filename="pipeline_featured.jpg")
        
        # Resolve associated categories based off brief structure
        categories = ["Blog"]
        if "keyword" in brief:
            categories.append(brief["keyword"])
            
        category_ids = await sync_categories(client, categories)
        
        # Commit to Wordpress post creation
        slug = brief['title'].replace(" ", "-").lower()
        payload = {
            "title": brief['title'],
            "content": html_content,
            "status": "publish",  # Pushing to published
            "slug": slug,
            "excerpt": f"Read about {brief['title']}.",
            "categories": category_ids,
        }
        if media_id:
            logger.info(f"Attaching Media ID: {media_id} to Payload...")
            payload["featured_media"] = media_id
            
        post_response = await publish_wordpress_post(client, payload)
        
        live_url = f"{WP_URL}/posts/{slug}"
        if post_response and "link" in post_response:
            live_url = post_response["link"]
            
        return {
            "live_url": live_url,
            "image_url": cloudinary_url or "https://via.placeholder.com/800x400"
        }
# -------------------------------------------------------------------------

def process_brief(brief_id):
    # Fetch brief
    response = supabase.table("content_briefs").select("*").eq("id", brief_id).execute()
    if not response.data:
        logger.error(f"Agent 02: Brief {brief_id} not found!")
        return
        
    brief = response.data[0]
    
    if brief['status'] != 'PENDING':
        logger.info(f"Agent 02: Brief {brief_id} is already processing or published. Skipping...")
        return
    
    # Update status
    supabase.table("content_briefs").update({"status": "IN_PROGRESS"}).eq("id", brief_id).execute()
    
    # Generate content
    html_content, seo_score = generate_blog_post(brief)
    
    # Offload to async execution
    logger.info("Agent 02: Launching publishing pipeline...")
    pipeline_result = asyncio.run(run_publishing_pipeline(brief, html_content))
    
    live_url = pipeline_result["live_url"]
    image_url = pipeline_result["image_url"]
    
    # Save to Supabase DB 'content' table
    post_response = supabase.table("content").insert({
        "brief_id": brief_id,
        "title": brief['title'],
        "html_content": html_content,
        "seo_score": seo_score,
        "live_url": live_url,
        "featured_image_url": image_url,
        "status": "PUBLISHED"
    }).execute()
    
    # Update brief status
    supabase.table("content_briefs").update({"status": "PUBLISHED"}).eq("id", brief_id).execute()
    
    # Emit event
    post_id = post_response.data[0]['id']
    event_data = {
        "event": "post_published",
        "post_id": post_id,
        "live_url": live_url
    }
    redis_client.publish("content_events", json.dumps(event_data))
    logger.info(f"Agent 02: Blog post {post_id} published & event emitted!")

def listen_for_events():
    """
    Listen on Redis queue.
    """
    logger.info("Agent 02 - Blog Writer listening for events...")
    pubsub = redis_client.pubsub()
    pubsub.subscribe("content_events")
    
    for message in pubsub.listen():
        if message['type'] == 'message':
            data = json.loads(message['data'])
            if data['event'] == 'content_briefs_ready':
                brief_id = data['brief_id']
                process_brief(brief_id)

if __name__ == "__main__":
    listen_for_events()
