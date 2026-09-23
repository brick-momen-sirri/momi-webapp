import { describe, expect, it } from "vitest";

import { profilePictureSources } from "./profilePictures";

describe("profilePictureSources", () => {
  it("builds a responsive srcset and original URL for managed portraits", () => {
    const sources = profilePictureSources("/api/profile-pictures/momen-dsc6470-0123456789/avatar-256.webp");

    expect(sources).toEqual({
      src: "/api/profile-pictures/momen-dsc6470-0123456789/avatar-256.webp",
      srcSet: [64, 128, 256, 512]
        .map((size) => `/api/profile-pictures/momen-dsc6470-0123456789/avatar-${size}.webp ${size}w`)
        .join(", "),
      originalUrl: "/api/profile-pictures/momen-dsc6470-0123456789/original.png",
    });
  });

  it("leaves uploaded and external images unchanged", () => {
    expect(profilePictureSources("data:image/jpeg;base64,abc")).toEqual({ src: "data:image/jpeg;base64,abc" });
    expect(profilePictureSources("https://example.com/avatar.jpg")).toEqual({ src: "https://example.com/avatar.jpg" });
    expect(profilePictureSources()).toBeUndefined();
  });

  it("resolves every managed rendition through the supplied media URL resolver", () => {
    const resolveUrl = (url: string) => `${url}?access_token=mt_test`;
    const sources = profilePictureSources(
      "/api/profile-pictures/momen-dsc6470-0123456789/avatar-256.webp",
      resolveUrl,
    );

    expect(sources?.src).toContain("avatar-256.webp?access_token=mt_test");
    expect(sources?.srcSet).toContain("avatar-64.webp?access_token=mt_test 64w");
    expect(sources?.srcSet).toContain("avatar-512.webp?access_token=mt_test 512w");
    expect(sources?.originalUrl).toContain("original.png?access_token=mt_test");
  });
});
