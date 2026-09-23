import { useState } from "react";
import { resolveMediaUrl } from "../services/api/mediaAccess";
import type { User } from "../types";
import { profilePictureSources } from "../utils/profilePictures";

type ProfileAvatarProps = {
  user: Pick<User, "name" | "avatar" | "avatarColor" | "profileImageUrl">;
  size?: "compact" | "small" | "large";
  className?: string;
  alt?: string;
};

const sizeClasses = {
  compact: "h-7 w-7 text-[11px]",
  small: "h-8 w-8 text-xs",
  large: "h-16 w-16 text-lg",
};

const imageSizes = {
  compact: "28px",
  small: "32px",
  large: "64px",
};

export function ProfileAvatar({ user, size = "small", className = "", alt = "" }: ProfileAvatarProps) {
  const [failedImageUrl, setFailedImageUrl] = useState<string>();
  const sources =
    user.profileImageUrl === failedImageUrl
      ? undefined
      : profilePictureSources(user.profileImageUrl, resolveMediaUrl);
  const initials =
    user.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") ||
    user.avatar ||
    "US";

  return (
    <span
      className={`${sizeClasses[size]} flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold text-white ${className}`}
      style={{ backgroundColor: user.avatarColor ?? "#d6d0c4" }}
    >
      {sources ? (
        <img
          src={sources.src}
          srcSet={sources.srcSet}
          sizes={sources.srcSet ? imageSizes[size] : undefined}
          alt={alt}
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailedImageUrl(user.profileImageUrl)}
        />
      ) : (
        initials
      )}
    </span>
  );
}
