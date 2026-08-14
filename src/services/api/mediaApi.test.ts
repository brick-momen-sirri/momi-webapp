import { describe, expect, it } from "vitest";
import { playableVideoUrl, thumbnailMediaUrl, THUMBNAIL_WIDTH } from "./mediaApi";

describe("playableVideoUrl", () => {
  it("rewrites a direct media path to the playable route", () => {
    const url = playableVideoUrl("/api/media?path=C%3A%5Crenders%5Cshot.mp4");
    expect(url).toBe("/api/media/playable?path=C%3A%5Crenders%5Cshot.mp4");
  });

  it("keeps the access token on the rewritten URL", () => {
    // Dropping this would turn every video into a 401 for anyone relying on the
    // query-string credential rather than the cookie.
    const url = playableVideoUrl("/api/media?path=C%3A%5Cshot.mp4&access_token=mt_abc");
    expect(url).toContain("/api/media/playable");
    expect(url).toContain("access_token=mt_abc");
  });

  it("flags the proxied result-media route instead of rewriting its path", () => {
    const url = playableVideoUrl("https://momi.example/api/jobs/job_1/result-media?index=2");
    expect(url).toBe("https://momi.example/api/jobs/job_1/result-media?index=2&playable=1");
  });

  it("leaves unrelated URLs, data URLs and blobs alone", () => {
    expect(playableVideoUrl("/api/media/thumbnail?path=x&w=480")).toBe("/api/media/thumbnail?path=x&w=480");
    expect(playableVideoUrl("https://cdn.example/clip.mp4")).toBe("https://cdn.example/clip.mp4");
    expect(playableVideoUrl("data:video/mp4;base64,AAAA")).toBe("data:video/mp4;base64,AAAA");
    expect(playableVideoUrl("blob:https://momi.example/abc")).toBe("blob:https://momi.example/abc");
    expect(playableVideoUrl(undefined)).toBeUndefined();
  });

  it("is idempotent, so a re-render of the same result does not stack parameters", () => {
    const once = playableVideoUrl("/api/media?path=C%3A%5Cshot.mp4");
    expect(playableVideoUrl(once)).toBe(once);

    const proxied = playableVideoUrl("/api/jobs/job_1/result-media?index=0");
    expect(playableVideoUrl(proxied)).toBe(proxied);
  });

  it("does not collide with the thumbnail rewrite", () => {
    // Both read the same source URL shape; the poster stays an image rendition
    // while the player moves to the video rendition.
    const source = "/api/media?path=C%3A%5Cshot.mp4";
    expect(thumbnailMediaUrl(source, THUMBNAIL_WIDTH.preview)).toContain("/api/media/thumbnail");
    expect(playableVideoUrl(source)).toContain("/api/media/playable");
  });
});
