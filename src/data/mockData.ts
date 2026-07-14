import type { Job, ModelType, Project, Team, User } from "../types";

export const currentUserId = "usr_momen";

export const users: User[] = [
  { id: "usr_momen", name: "momen", email: "momen@brickvisual.com", avatar: "MO", avatarColor: "#11b8a5" },
  { id: "usr_lina", name: "Lina", email: "lina@brickvisual.com", avatar: "LI", avatarColor: "#ff6b35" },
  { id: "usr_sami", name: "Sami", email: "sami@brickvisual.com", avatar: "SA", avatarColor: "#4f46e5" },
  { id: "usr_nora", name: "Nora", email: "nora@brickvisual.com", avatar: "NO", avatarColor: "#0f766e" },
];

export const teams: Team[] = [
  { id: "team_creative", name: "Creative Studio", users },
  { id: "team_production", name: "Production Review", users: users.slice(0, 3) },
];

const addedAt = "2026-04-10T11:20:00Z";

export const modelTypes: ModelType[] = [
  {
    id: "image_to_image",
    label: "Image to Image",
    description: "Transform an uploaded reference into a new still.",
    category: "image",
    cost: 4,
    estimatedTime: "45 sec",
    requiresLandscape: false,
  },
  {
    id: "text_to_image",
    label: "Text to Image",
    description: "Generate a still from prompt text only.",
    category: "image",
    cost: 3,
    estimatedTime: "35 sec",
  },
  {
    id: "start_end_frames",
    label: "Start & End Frames",
    description: "Animate between two locked 16:9 frames.",
    category: "video",
    cost: 18,
    estimatedTime: "2.6 min",
    requiresTwoImages: true,
    requiresLandscape: true,
    supportsAudio: true,
  },
  {
    id: "video_generation",
    label: "Video Generation",
    description: "Create a short cinematic video from an image.",
    category: "video",
    cost: 12,
    estimatedTime: "1.8 min",
    requiresLandscape: true,
    supportsAudio: true,
  },
  {
    id: "creative_upscaler",
    label: "Creative Upscaler",
    description: "Upscale and add guided detail to an existing frame.",
    category: "upscale",
    cost: 8,
    estimatedTime: "1.2 min",
  },
  {
    id: "magnific_upscale",
    label: "Magnific / Upscale model",
    description: "High-detail upscale with creativity controls.",
    category: "upscale",
    cost: 10,
    estimatedTime: "1.5 min",
  },
  {
    id: "google_veo",
    label: "Google Veo / third-party video model",
    description: "Third-party image-to-video with strict 16:9 input.",
    category: "video",
    cost: 24,
    estimatedTime: "2.6 min",
    requiresLandscape: true,
    supportsAudio: true,
  },
];

export const initialProjects: Project[] = [
  {
    id: "prj_playground",
    name: "Playground",
    shortName: "PLAY",
    description: "Personal tests, draft looks, and fast prompt trials.",
    ownerId: "usr_momen",
    members: [
      { userId: "usr_momen", role: "owner", addedAt, addedBy: "usr_momen" },
      { userId: "usr_lina", role: "editor", addedAt, addedBy: "usr_momen" },
    ],
    groupMembers: [{ groupId: "team_creative", role: "viewer", addedAt, addedBy: "usr_momen" }],
    jobCount: 382,
    memberCount: 4,
    unreadCount: 61,
    createdAt: "2026-04-10T11:20:00Z",
    visibility: "team",
  },
  {
    id: "prj_stadium",
    name: "Stadium Animation",
    shortName: "7443",
    description: "Match-day hero shots and animated pitch boards.",
    ownerId: "usr_momen",
    members: [
      { userId: "usr_momen", role: "owner", addedAt: "2026-05-16T09:00:00Z", addedBy: "usr_momen" },
      { userId: "usr_sami", role: "viewer", addedAt: "2026-05-16T09:00:00Z", addedBy: "usr_momen" },
    ],
    groupMembers: [],
    jobCount: 41,
    memberCount: 2,
    unreadCount: 7,
    createdAt: "2026-05-16T09:00:00Z",
    visibility: "private",
  },
  {
    id: "prj_marketing",
    name: "Marketing",
    shortName: "MKT",
    description: "Campaign image variations and product launch tests.",
    ownerId: "usr_lina",
    members: [
      { userId: "usr_momen", role: "editor", addedAt: "2026-05-20T14:35:00Z", addedBy: "usr_lina" },
      { userId: "usr_lina", role: "owner", addedAt: "2026-05-20T14:35:00Z", addedBy: "usr_lina" },
      { userId: "usr_nora", role: "viewer", addedAt: "2026-05-20T14:35:00Z", addedBy: "usr_lina" },
    ],
    groupMembers: [{ groupId: "team_creative", role: "editor", addedAt: "2026-05-20T14:35:00Z", addedBy: "usr_lina" }],
    jobCount: 164,
    memberCount: 8,
    unreadCount: 18,
    createdAt: "2026-05-20T14:35:00Z",
    visibility: "team",
  },
  {
    id: "prj_training",
    name: "AI Training",
    shortName: "TRAIN",
    description: "Internal examples for prompt quality and moderation.",
    ownerId: "usr_sami",
    members: [
      { userId: "usr_sami", role: "owner", addedAt: "2026-03-08T08:45:00Z", addedBy: "usr_sami" },
      { userId: "usr_momen", role: "viewer", addedAt: "2026-03-08T08:45:00Z", addedBy: "usr_sami" },
    ],
    groupMembers: [{ groupId: "team_production", role: "viewer", addedAt: "2026-03-08T08:45:00Z", addedBy: "usr_sami" }],
    jobCount: 52,
    memberCount: 11,
    unreadCount: 11,
    createdAt: "2026-03-08T08:45:00Z",
    visibility: "team",
  },
  {
    id: "prj_brick",
    name: "Brick Marketing",
    shortName: "BRICK",
    description: "Brand texture explorations and social cutdowns.",
    ownerId: "usr_nora",
    members: [
      { userId: "usr_nora", role: "owner", addedAt: "2026-06-02T16:10:00Z", addedBy: "usr_nora" },
      { userId: "usr_momen", role: "editor", addedAt: "2026-06-02T16:10:00Z", addedBy: "usr_nora" },
    ],
    groupMembers: [],
    jobCount: 31,
    memberCount: 3,
    unreadCount: 5,
    createdAt: "2026-06-02T16:10:00Z",
    visibility: "private",
  },
  {
    id: "prj_research",
    name: "Research Tests",
    shortName: "RND",
    description: "Experimental pipelines and comparison runs.",
    ownerId: "usr_momen",
    members: [{ userId: "usr_momen", role: "owner", addedAt: "2026-01-19T13:10:00Z", addedBy: "usr_momen" }],
    groupMembers: [],
    jobCount: 1129,
    memberCount: 1,
    unreadCount: 133,
    createdAt: "2026-01-19T13:10:00Z",
    visibility: "private",
  },
];

export const initialJobs: Job[] = [];
