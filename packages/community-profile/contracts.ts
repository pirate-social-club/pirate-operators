/** Public metadata is separate from credentials, private account IDs and handles. */
export interface PublicProfile {
  schema: "pirate.community-profile/1";
  communityId: string;
  authorId: string;
  revision: number;
  displayName: string | null;
  bio: string | null;
  avatarRef: string | null;
  coverRef: string | null;
}
export interface OwnerProfile {
  schema: "pirate.community-profile-owner/1";
  communityId: string;
  accountId: string;
  profile: PublicProfile;
  capabilities: { metadata: true; publicMedia: boolean; handles: false };
}
export interface ProfileMutation {
  mutationId: string;
  expectedRevision: number;
  displayName: string | null;
  bio: string | null;
  avatarRef: string | null;
  coverRef: string | null;
}
export interface ProfileMutationReceipt {
  schema: "pirate.community-profile-mutation/1";
  mutationId: string;
  profile: PublicProfile;
}
export interface ProfileActivityPage<TPost> {
  schema: "pirate.community-profile-activity/1";
  communityId: string;
  authorId: string;
  profile: PublicProfile;
  items: TPost[];
  nextCursor: string | null;
  window: "current-public-catalogue";
}
