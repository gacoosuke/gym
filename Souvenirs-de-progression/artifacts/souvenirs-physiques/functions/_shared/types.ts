export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  SETUP_SECRET?: string;
  SESSION_TTL_DAYS?: string;
  MAX_UPLOAD_BYTES?: string;
  STORAGE_LIMIT_BYTES?: string;
}

export interface Member {
  id: "ali" | "zakaria" | "idrissa";
  name: string;
  color: string;
}

export interface SessionRecord {
  token_hash: string;
  member_id: Member["id"];
  expires_at: string;
}

export interface MediaRecord {
  id: string;
  member_id: Member["id"];
  r2_key: string;
  media_type: "image";
  content_type: string;
  size_bytes: number;
  taken_at: string;
  taken_date: string;
  caption: string | null;
  tagged_users: string;
  created_at: string;
}

export type AppContext = {
  Bindings: Env;
  Variables: { member: Member };
};

export const MEMBER_DATA: Member[] = [
  { id: "ali", name: "Ali", color: "#3B82F6" },
  { id: "zakaria", name: "Zakaria", color: "#10B981" },
  { id: "idrissa", name: "Idrissa", color: "#8B5CF6" },
];