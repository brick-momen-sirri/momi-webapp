const managedProfilePicturePattern =
  /^(.*\/api\/profile-pictures\/[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?)\/avatar-(?:64|128|256|512)\.webp$/;
const renditionSizes = [64, 128, 256, 512] as const;

export type ProfilePictureSources = {
  src: string;
  srcSet?: string;
  originalUrl?: string;
};

export function profilePictureSources(
  profileImageUrl?: string,
  resolveUrl: (url: string) => string = (url) => url,
): ProfilePictureSources | undefined {
  if (!profileImageUrl) return undefined;
  const match = profileImageUrl.match(managedProfilePicturePattern);
  if (!match) return { src: resolveUrl(profileImageUrl) };

  const root = match[1];
  return {
    src: resolveUrl(profileImageUrl),
    srcSet: renditionSizes.map((size) => `${resolveUrl(`${root}/avatar-${size}.webp`)} ${size}w`).join(", "),
    originalUrl: resolveUrl(`${root}/original.png`),
  };
}
