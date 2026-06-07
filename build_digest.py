#!/usr/bin/env python3
"""Build a static Reddit digest for GitHub Pages.

Uses Reddit's public JSON listings first and the public Atom/RSS feed as a
fallback. No Reddit credentials are required.
"""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "subreddits.json"
OUTPUT_PATH = ROOT / "data" / "digest.json"
USER_AGENT = "reddit-briefing-github-pages/3.0 (read-only public digest)"
TIMEOUT_SECONDS = 24
MAX_POSTS = 28
MAX_AGE_HOURS = 28


def request(url: str, accept: str) -> bytes:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": accept,
        "Accept-Language": "en-GB,en;q=0.8",
        "Cache-Control": "no-cache",
    }
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
                return response.read()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"request failed for {url}: {last_error}")


def fetch_json(url: str) -> Any:
    raw = request(url, "application/json")
    text = raw.decode("utf-8", errors="replace").lstrip()
    if text.startswith("<"):
        raise RuntimeError("Reddit returned HTML instead of JSON")
    return json.loads(text)


def fetch_text(url: str) -> str:
    return request(url, "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8").decode(
        "utf-8", errors="replace"
    )


def reddit_json_endpoints(subreddit: str, sort: str) -> list[str]:
    params = {"limit": str(MAX_POSTS), "raw_json": "1"}
    if sort == "top":
        params["t"] = "day"
    query = urllib.parse.urlencode(params)
    return [
        f"https://www.reddit.com/r/{subreddit}/{sort}.json?{query}",
        f"https://www.reddit.com/r/{subreddit}/{sort}/.json?{query}",
        f"https://api.reddit.com/r/{subreddit}/{sort}?{query}",
        f"https://old.reddit.com/r/{subreddit}/{sort}/.json?{query}",
    ]


def reddit_rss_endpoints(subreddit: str, sort: str) -> list[str]:
    params = {"limit": str(MAX_POSTS)}
    if sort == "top":
        params["t"] = "day"
    query = urllib.parse.urlencode(params)
    return [
        f"https://www.reddit.com/r/{subreddit}/{sort}/.rss?{query}",
        f"https://www.reddit.com/r/{subreddit}/{sort}.rss?{query}",
        f"https://old.reddit.com/r/{subreddit}/{sort}/.rss?{query}",
    ]


def clean_text(value: Any) -> str:
    return html.unescape(str(value or "")).replace("\x00", "").strip()


def safe_url(value: Any) -> str:
    text = clean_text(value)
    try:
        parsed = urllib.parse.urlparse(text)
    except ValueError:
        return ""
    return text if parsed.scheme in {"http", "https"} and parsed.netloc else ""


def absolute_reddit_url(value: Any) -> str:
    text = clean_text(value)
    if not text:
        return ""
    return safe_url(text) if text.startswith("http") else f"https://www.reddit.com{text}"


def preview_image(post: dict[str, Any]) -> str:
    try:
        return clean_text(post["preview"]["images"][0]["source"]["url"])
    except (KeyError, IndexError, TypeError):
        return ""


def youtube_id(url: str) -> str:
    try:
        parsed = urllib.parse.urlparse(url)
        host = parsed.netloc.lower()
        if "youtu.be" in host:
            return parsed.path.strip("/").split("/")[0]
        if "youtube.com" in host:
            parts = parsed.path.strip("/").split("/")
            if parts and parts[0] == "shorts" and len(parts) > 1:
                return parts[1]
            return urllib.parse.parse_qs(parsed.query).get("v", [""])[0]
    except ValueError:
        return ""
    return ""


def extract_media(post: dict[str, Any]) -> dict[str, Any]:
    reddit_video = (
        (post.get("secure_media") or {}).get("reddit_video")
        or (post.get("media") or {}).get("reddit_video")
    )
    if reddit_video and reddit_video.get("fallback_url"):
        return {
            "type": "video",
            "url": clean_text(reddit_video["fallback_url"]),
            "poster": preview_image(post),
        }

    if post.get("is_gallery") and post.get("gallery_data") and post.get("media_metadata"):
        images: list[str] = []
        for item in post["gallery_data"].get("items", []):
            metadata = post["media_metadata"].get(item.get("media_id"), {})
            source = metadata.get("s", {})
            image = source.get("u") or source.get("gif")
            if image:
                images.append(clean_text(image))
        if images:
            return {"type": "gallery", "images": images[:8]}

    destination = clean_text(post.get("url_overridden_by_dest") or post.get("url"))
    if re.search(r"\.(?:jpe?g|png|gif|webp)(?:\?.*)?$", destination, flags=re.I) or post.get("post_hint") == "image":
        return {"type": "image", "url": destination or preview_image(post)}

    video_id = youtube_id(destination)
    if video_id:
        return {"type": "youtube", "id": video_id}

    preview = preview_image(post)
    if preview:
        return {"type": "image", "url": preview, "previewOnly": True}
    return {"type": "none"}


def normalise_json_post(post: dict[str, Any]) -> dict[str, Any] | None:
    if not post.get("id") or not post.get("title"):
        return None
    return {
        "id": str(post["id"]),
        "subreddit": clean_text(post.get("subreddit")),
        "title": clean_text(post.get("title")),
        "selftext": clean_text(post.get("selftext")),
        "author": clean_text(post.get("author")),
        "score": int(post.get("score") or post.get("ups") or 0),
        "numComments": int(post.get("num_comments") or 0),
        "upvoteRatio": float(post.get("upvote_ratio") or 0),
        "createdUtc": float(post.get("created_utc") or 0),
        "permalink": absolute_reddit_url(post.get("permalink")),
        "url": safe_url(post.get("url_overridden_by_dest") or post.get("url"))
        or absolute_reddit_url(post.get("permalink")),
        "domain": clean_text(post.get("domain")),
        "flair": clean_text(post.get("link_flair_text")),
        "stickied": bool(post.get("stickied")),
        "spoiler": bool(post.get("spoiler")),
        "over18": bool(post.get("over_18")),
        "media": extract_media(post),
    }


def parse_json_listing(payload: Any) -> list[dict[str, Any]]:
    children = payload.get("data", {}).get("children", []) if isinstance(payload, dict) else []
    if not isinstance(children, list):
        raise RuntimeError("unexpected Reddit listing format")
    result = []
    for item in children:
        post = normalise_json_post((item or {}).get("data") or {})
        if post:
            result.append(post)
    return result


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def child_text(element: ET.Element, name: str) -> str:
    for child in element.iter():
        if local_name(child.tag) == name:
            return "".join(child.itertext()).strip()
    return ""


def atom_link(entry: ET.Element) -> str:
    for child in entry:
        if local_name(child.tag) == "link" and child.attrib.get("href"):
            return clean_text(child.attrib["href"])
    return ""


def first_image(value: str) -> str:
    match = re.search(r'<img\b[^>]*\bsrc=["\']([^"\']+)', value, flags=re.I)
    return safe_url(html.unescape(match.group(1))) if match else ""


def strip_html(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html.unescape(value))).strip()


def post_id_from_url(value: str) -> str:
    match = re.search(r"/comments/([A-Za-z0-9]+)", value)
    return match.group(1) if match else ""


def parse_rss_listing(xml_text: str, subreddit: str) -> list[dict[str, Any]]:
    root = ET.fromstring(xml_text)
    posts: list[dict[str, Any]] = []
    for entry in root.iter():
        if local_name(entry.tag) != "entry":
            continue
        title = clean_text(child_text(entry, "title"))
        link = atom_link(entry)
        post_id = post_id_from_url(link) or post_id_from_url(child_text(entry, "id"))
        if not title or not post_id:
            continue
        updated_text = child_text(entry, "updated") or child_text(entry, "published")
        try:
            created = dt.datetime.fromisoformat(updated_text.replace("Z", "+00:00")).timestamp()
        except ValueError:
            created = time.time()
        content_raw = child_text(entry, "content")
        author = child_text(entry, "name").replace("/u/", "")
        image = first_image(content_raw)
        posts.append(
            {
                "id": post_id,
                "subreddit": subreddit,
                "title": title,
                "selftext": strip_html(content_raw),
                "author": clean_text(author),
                "score": 0,
                "numComments": 0,
                "upvoteRatio": 0,
                "createdUtc": created,
                "permalink": safe_url(link),
                "url": safe_url(link),
                "domain": "reddit.com",
                "flair": "",
                "stickied": False,
                "spoiler": False,
                "over18": False,
                "media": {"type": "image", "url": image, "previewOnly": True}
                if image
                else {"type": "none"},
            }
        )
    return posts


def fetch_listing(subreddit: str, sort: str) -> tuple[list[dict[str, Any]], str]:
    errors: list[str] = []
    for endpoint in reddit_json_endpoints(subreddit, sort):
        try:
            posts = parse_json_listing(fetch_json(endpoint))
            if posts:
                return posts, "json"
        except Exception as exc:  # noqa: BLE001 - diagnostics are recorded in the output
            errors.append(str(exc))

    for endpoint in reddit_rss_endpoints(subreddit, sort):
        try:
            posts = parse_rss_listing(fetch_text(endpoint), subreddit)
            if posts:
                return posts, "rss"
        except Exception as exc:  # noqa: BLE001
            errors.append(str(exc))

    raise RuntimeError("; ".join(errors[-4:]) or "no posts returned")


def is_recent(post: dict[str, Any]) -> bool:
    created = float(post.get("createdUtc") or 0)
    return not created or time.time() - created <= MAX_AGE_HOURS * 3600


def main() -> int:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    subreddits = [item["name"] for item in config.get("subreddits", [])]
    if not subreddits:
        raise RuntimeError("subreddits.json contains no communities")

    output: dict[str, Any] = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "top": [],
        "hot": [],
        "failures": [],
        "sources": {},
    }

    jobs = [(subreddit, sort) for sort in ("top", "hot") for subreddit in subreddits]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        future_map = {
            executor.submit(fetch_listing, subreddit, sort): (subreddit, sort)
            for subreddit, sort in jobs
        }
        for future in concurrent.futures.as_completed(future_map):
            subreddit, sort = future_map[future]
            try:
                posts, source = future.result()
                recent = [post for post in posts if is_recent(post) and not post.get("stickied")]
                output[sort].extend(recent)
                output["sources"][f"{sort}:{subreddit}"] = source
                print(f"{sort:>3} r/{subreddit:<14} {len(recent):>2} posts via {source}")
            except Exception as exc:  # noqa: BLE001
                message = str(exc)
                output["failures"].append({"subreddit": subreddit, "sort": sort, "message": message})
                print(f"ERROR {sort} r/{subreddit}: {message}", file=sys.stderr)

    # Stable order before the browser applies its final engagement/freshness ranking.
    for sort in ("top", "hot"):
        output[sort].sort(
            key=lambda post: (int(post.get("score") or 0), int(post.get("numComments") or 0), float(post.get("createdUtc") or 0)),
            reverse=True,
        )

    successful_feeds = len(jobs) - len(output["failures"])
    if successful_feeds < max(2, len(subreddits) // 2) or not output["top"]:
        raise RuntimeError(
            f"Only {successful_feeds}/{len(jobs)} feeds succeeded; refusing to deploy an empty briefing"
        )

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(OUTPUT_PATH)
    print(f"Wrote {len(output['top'])} top and {len(output['hot'])} hot posts to {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
