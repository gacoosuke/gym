import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { AppContext, Env, MediaRecord, Member } from "../_shared/types";
import { MEMBER_DATA } from "../_shared/types";
import {
  checkLoginLimit,
  createPinSalt,
  hashPin,
  hashSessionToken,
  recordFailedLogin,
  sessionExpiry,
  sessionMiddleware,
  verifyPin,
  verifySetupSecret,
} from "../_shared/auth";

const app = new Hono<AppContext>();
const imageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
const reactionEmojis = new Set(["💪", "🔥", "🦍", "📈"]);
const memberIds = new Set(["ali", "zakaria", "idrissa"]);
const hardcodedPins: Record<Member["id"], string> = {
  ali: "123456",
  idrissa: "190619",
  zakaria: "999999",
};
const storageLimitDefault = 10 * 1024 * 1024 * 1024;

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type", "x-setup-secret"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86_400,
  }),
);
app.use("*", sessionMiddleware);

function isMemberId(value: unknown): value is Member["id"] {
  return typeof value === "string" && memberIds.has(value);
}

function validIsoDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function parseTags(value: unknown, defaultMember: Member["id"]): Member["id"][] | null {
  let raw = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (raw === undefined || raw === null) return [defaultMember];
  if (!Array.isArray(raw) || raw.length > 3 || !raw.every(isMemberId)) return null;
  return [...new Set([defaultMember, ...raw])];
}

function photoDto(row: MediaRecord & { member_name: string }) {
  let taggedMemberIds: string[] = [];
  try {
    taggedMemberIds = JSON.parse(row.tagged_users) as string[];
  } catch {
    taggedMemberIds = [row.member_id];
  }
  return {
    id: row.id,
    memberId: row.member_id,
    memberName: row.member_name,
    taggedMemberIds,
    takenAt: row.taken_at,
    uploadedAt: row.created_at,
    caption: row.caption,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    contentPath: `/api/media/${row.id}/content`,
  };
}

async function findPhoto(
  env: Env,
  id: string,
): Promise<(MediaRecord & { member_name: string }) | null> {
  return env.DB.prepare(
    `SELECT media.*, members.name AS member_name
     FROM media JOIN members ON members.id = media.member_id
     WHERE media.id = ?`,
  )
    .bind(id)
    .first<MediaRecord & { member_name: string }>();
}

function isValidCaption(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 500);
}

function readLimit(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

app.get("/api/healthz", (c) => c.json({ status: "ok" }));

app.get("/api/members", async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT id, name, color_theme AS color FROM members ORDER BY id",
  ).all<Member>();
  return c.json(result.results);
});

app.post("/api/setup/pins", async (c) => {
  const suppliedSecret = c.req.header("x-setup-secret");
  if (!(await verifySetupSecret(suppliedSecret, c.env.SETUP_SECRET))) {
    return c.json({ error: "Configuration initiale non autorisée." }, 401);
  }

  const configured = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM members WHERE pin_hash IS NOT NULL",
  ).first<{ count: number }>();
  if ((configured?.count ?? 0) > 0) {
    return c.json({ error: "Les codes ont déjà été configurés." }, 409);
  }

  const pins = hardcodedPins;

  const statements = await Promise.all(
    MEMBER_DATA.map(async ({ id }) => {
      const salt = createPinSalt();
      const saltBase64 = btoa(String.fromCharCode(...salt));
      const pinHash = await hashPin(pins[id], salt);
      return c.env.DB.prepare(
        "UPDATE members SET pin_salt = ?, pin_hash = ? WHERE id = ? AND pin_hash IS NULL",
      ).bind(saltBase64, pinHash, id);
    }),
  );
  await c.env.DB.batch(statements);
  return c.json({ success: true });
});

app.post("/api/session", async (c) => {
  const rateLimit = await checkLoginLimit(c);
  if (!rateLimit.allowed) {
    return c.json(
      { error: "Trop de tentatives. Réessayez dans quelques minutes." },
      429,
      { "Retry-After": "600" },
    );
  }

  let input: { memberId?: unknown; pin?: unknown };
  try {
    input = await c.req.json();
  } catch {
    return c.json({ error: "Requête invalide." }, 400);
  }
  if (!isMemberId(input.memberId) || typeof input.pin !== "string" || !/^\d{6,12}$/.test(input.pin)) {
    await recordFailedLogin(c.env.DB, rateLimit.ipAddress);
    return c.json({ error: "Membre ou code incorrect." }, 401);
  }

  const hardcodedPin = hardcodedPins[input.memberId];
  const memberRow = await c.env.DB.prepare(
    `SELECT id, name, color_theme AS color, pin_salt, pin_hash
     FROM members WHERE id = ?`,
  )
    .bind(input.memberId)
    .first<Member & { pin_salt: string | null; pin_hash: string | null }>();

  const isValidHardcodedPin = typeof hardcodedPin === "string" && hardcodedPin === input.pin;
  const isValidStoredPin =
    !!memberRow?.pin_salt &&
    !!memberRow.pin_hash &&
    (await verifyPin(input.pin, memberRow.pin_salt, memberRow.pin_hash));

  if (!memberRow) {
    await recordFailedLogin(c.env.DB, rateLimit.ipAddress);
    return c.json({ error: "Membre ou code incorrect." }, 401);
  }

  if (!isValidHardcodedPin && !isValidStoredPin) {
    await recordFailedLogin(c.env.DB, rateLimit.ipAddress);
    return c.json({ error: "Membre ou code incorrect." }, 401);
  }

  await c.env.DB.prepare("DELETE FROM login_attempts WHERE ip_address = ?")
    .bind(rateLimit.ipAddress)
    .run();

  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const expiresAt = sessionExpiry(c.env.SESSION_TTL_DAYS);
  const tokenHash = await hashSessionToken(token);
  await c.env.DB.prepare(
    "INSERT INTO sessions (token_hash, member_id, expires_at) VALUES (?, ?, ?)",
  )
    .bind(tokenHash, memberRow.id, expiresAt)
    .run();

  return c.json(
    {
      token,
      expiresAt,
      member: { id: memberRow.id, name: memberRow.name, color: memberRow.color },
    },
    200,
    { "Cache-Control": "no-store" },
  );
});

app.get("/api/session/current", (c) => c.json(c.get("member")));

app.delete("/api/session", async (c) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  if (token) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await hashSessionToken(token))
      .run();
  }
  return c.body(null, 204);
});

app.get("/api/media", async (c) => {
  const memberId = c.req.query("memberId");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const limit = readLimit(c.req.query("limit"), 100, 200);
  if (memberId && !isMemberId(memberId)) {
    return c.json({ error: "Membre invalide." }, 400);
  }
  if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) {
    return c.json({ error: "Période invalide." }, 400);
  }

  const conditions: string[] = [];
  const bindings: (string | number)[] = [];
  if (memberId) {
    conditions.push("(media.member_id = ? OR instr(media.tagged_users, ?) > 0)");
    bindings.push(memberId, `"${memberId}"`);
  }
  if (from) {
    conditions.push("media.taken_date >= ?");
    bindings.push(from);
  }
  if (to) {
    conditions.push("media.taken_date <= ?");
    bindings.push(to);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const results = await c.env.DB.prepare(
    `SELECT media.*, members.name AS member_name
     FROM media JOIN members ON members.id = media.member_id
     ${where}
     ORDER BY media.taken_at DESC, media.created_at DESC
     LIMIT ?`,
  )
    .bind(...bindings, limit)
    .all<MediaRecord & { member_name: string }>();
  return c.json(results.results.map(photoDto));
});

app.post("/api/media", async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Fichier photo absent ou invalide." }, 400);
  }

  const file = form.get("file");
  const takenAt = form.get("takenAt");
  const captionValue = form.get("caption");
  const taggedValue = form.get("taggedMemberIds");
  const member = c.get("member");
  const maxBytes = readLimit(c.env.MAX_UPLOAD_BYTES, 8 * 1024 * 1024, 20 * 1024 * 1024);
  if (!(file instanceof File) || file.size <= 0 || file.size > maxBytes) {
    return c.json({ error: "La photo est vide ou dépasse la taille maximale autorisée." }, 413);
  }
  if (!imageTypes.has(file.type.toLowerCase())) {
    return c.json({ error: "Formats acceptés : JPEG, PNG, WebP et AVIF." }, 415);
  }
  if (!validIsoDateTime(takenAt)) {
    return c.json({ error: "La date de prise de vue est invalide." }, 400);
  }
  if (!isValidCaption(captionValue)) {
    return c.json({ error: "La légende est trop longue." }, 400);
  }
  const tags = parseTags(taggedValue, member.id);
  if (!tags) return c.json({ error: "Liste de membres invalide." }, 400);

  const storageUsage = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(size_bytes), 0) AS used_bytes FROM media",
  ).first<{ used_bytes: number }>();
  const storageLimit = readLimit(
    c.env.STORAGE_LIMIT_BYTES,
    storageLimitDefault,
    storageLimitDefault,
  );
  if ((storageUsage?.used_bytes ?? 0) + file.size > storageLimit) {
    return c.json({ error: "L’espace de stockage partagé est plein." }, 413);
  }

  const id = crypto.randomUUID();
  const r2Key = `memories/${member.id}/${id}`;
  const dateKey = takenAt.slice(0, 10);
  try {
    await c.env.BUCKET.put(r2Key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type },
      customMetadata: { mediaId: id, memberId: member.id, takenAt },
    });
    await c.env.DB.prepare(
      `INSERT INTO media
       (id, member_id, r2_key, media_type, content_type, size_bytes, taken_at, taken_date, caption, tagged_users)
       VALUES (?, ?, ?, 'image', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        member.id,
        r2Key,
        file.type,
        file.size,
        takenAt,
        dateKey,
        typeof captionValue === "string" && captionValue.trim() ? captionValue.trim() : null,
        JSON.stringify(tags),
      )
      .run();
  } catch {
    await c.env.BUCKET.delete(r2Key).catch(() => undefined);
    return c.json({ error: "La photo n’a pas pu être enregistrée. Réessayez." }, 500);
  }

  const row = await findPhoto(c.env, id);
  if (!row) return c.json({ error: "La photo a été enregistrée mais reste introuvable." }, 500);
  return c.json(photoDto(row), 201);
});

app.get("/api/media/:id/content", async (c) => {
  const row = await findPhoto(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "Photo introuvable." }, 404);
  const object = await c.env.BUCKET.get(row.r2_key);
  if (!object) return c.json({ error: "Fichier photo introuvable dans le stockage." }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": row.content_type,
      "Content-Length": String(row.size_bytes),
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      ETag: object.httpEtag,
    },
  });
});

app.patch("/api/media/:id", async (c) => {
  const row = await findPhoto(c.env, c.req.param("id"));
  if (!row || row.member_id !== c.get("member").id) {
    return c.json({ error: "Photo introuvable ou modification non autorisée." }, 404);
  }

  let input: { takenAt?: unknown; caption?: unknown; taggedMemberIds?: unknown };
  try {
    input = await c.req.json();
  } catch {
    return c.json({ error: "Requête invalide." }, 400);
  }
  const takenAt = input.takenAt ?? row.taken_at;
  const caption = input.caption === undefined ? row.caption : input.caption;
  const tags = input.taggedMemberIds === undefined
    ? JSON.parse(row.tagged_users) as string[]
    : parseTags(input.taggedMemberIds, row.member_id);
  if (!validIsoDateTime(takenAt) || !isValidCaption(caption) || !tags) {
    return c.json({ error: "Date, légende ou membres invalides." }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE media
     SET taken_at = ?, taken_date = ?, caption = ?, tagged_users = ?
     WHERE id = ? AND member_id = ?`,
  )
    .bind(
      takenAt,
      takenAt.slice(0, 10),
      typeof caption === "string" && caption.trim() ? caption.trim() : null,
      JSON.stringify(tags),
      row.id,
      c.get("member").id,
    )
    .run();

  const updated = await findPhoto(c.env, row.id);
  return updated ? c.json(photoDto(updated)) : c.json({ error: "Photo introuvable." }, 404);
});

app.delete("/api/media/:id", async (c) => {
  const row = await findPhoto(c.env, c.req.param("id"));
  if (!row || row.member_id !== c.get("member").id) {
    return c.json({ error: "Photo introuvable ou suppression non autorisée." }, 404);
  }
  await c.env.BUCKET.delete(row.r2_key);
  await c.env.DB.prepare("DELETE FROM media WHERE id = ? AND member_id = ?")
    .bind(row.id, c.get("member").id)
    .run();
  return c.body(null, 204);
});

app.get("/api/calendar", async (c) => {
  const year = c.req.query("year");
  if (!year || !/^\d{4}$/.test(year) || Number(year) < 1900 || Number(year) > 2200) {
    return c.json({ error: "Année invalide." }, 400);
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, member_id, taken_date, tagged_users
     FROM media
     WHERE taken_date >= ? AND taken_date <= ?
     ORDER BY taken_date`,
  )
    .bind(`${year}-01-01`, `${year}-12-31`)
    .all<{ id: string; member_id: Member["id"]; taken_date: string; tagged_users: string }>();

  const days = new Map<string, { date: string; memberIds: Set<string>; photoCount: number }>();
  for (const row of rows.results) {
    const day = days.get(row.taken_date) ?? {
      date: row.taken_date,
      memberIds: new Set<string>(),
      photoCount: 0,
    };
    day.photoCount += 1;
    day.memberIds.add(row.member_id);
    try {
      for (const id of JSON.parse(row.tagged_users) as string[]) day.memberIds.add(id);
    } catch {
      day.memberIds.add(row.member_id);
    }
    days.set(row.taken_date, day);
  }
  return c.json(
    [...days.values()]
      .sort((left, right) => left.date.localeCompare(right.date))
      .map(({ date, memberIds: ids, photoCount }) => ({
        date,
        memberIds: [...ids],
        photoCount,
      })),
  );
});

app.get("/api/media/:id/comments", async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT comments.id, comments.media_id AS mediaId,
            comments.member_id AS memberId, members.name AS memberName,
            comments.text, comments.created_at AS createdAt
     FROM comments JOIN members ON members.id = comments.member_id
     WHERE comments.media_id = ? ORDER BY comments.created_at ASC`,
  )
    .bind(c.req.param("id"))
    .all();
  return c.json(result.results);
});

app.post("/api/media/:id/comments", async (c) => {
  const media = await c.env.DB.prepare("SELECT id FROM media WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ id: string }>();
  if (!media) return c.json({ error: "Photo introuvable." }, 404);

  let input: { text?: unknown };
  try {
    input = await c.req.json();
  } catch {
    return c.json({ error: "Requête invalide." }, 400);
  }
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 500) {
    return c.json({ error: "Le commentaire doit contenir de 1 à 500 caractères." }, 400);
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO comments (id, media_id, member_id, text) VALUES (?, ?, ?, ?)",
  )
    .bind(id, media.id, c.get("member").id, input.text.trim())
    .run();
  const comment = await c.env.DB.prepare(
    `SELECT comments.id, comments.media_id AS mediaId,
            comments.member_id AS memberId, members.name AS memberName,
            comments.text, comments.created_at AS createdAt
     FROM comments JOIN members ON members.id = comments.member_id
     WHERE comments.id = ?`,
  )
    .bind(id)
    .first();
  return c.json(comment, 201);
});

async function getReactionCounts(
  c: Context<AppContext>,
  mediaId: string,
) {
  const rows = await c.env.DB.prepare(
    `SELECT emoji, COUNT(*) AS count,
            MAX(CASE WHEN member_id = ? THEN 1 ELSE 0 END) AS mine
     FROM reactions WHERE media_id = ? GROUP BY emoji`,
  )
    .bind(c.get("member").id, mediaId)
    .all<{ emoji: string; count: number; mine: number }>();
  return rows.results.map((row) => ({ emoji: row.emoji, count: row.count, mine: row.mine === 1 }));
}

app.get("/api/media/:id/reactions", async (c) => {
  const media = await c.env.DB.prepare("SELECT id FROM media WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ id: string }>();
  if (!media) return c.json({ error: "Photo introuvable." }, 404);
  return c.json(await getReactionCounts(c, media.id));
});

app.put("/api/media/:id/reactions", async (c) => {
  const mediaId = c.req.param("id");
  const media = await c.env.DB.prepare("SELECT id FROM media WHERE id = ?")
    .bind(mediaId)
    .first<{ id: string }>();
  if (!media) return c.json({ error: "Photo introuvable." }, 404);
  let input: { emoji?: unknown };
  try {
    input = await c.req.json();
  } catch {
    return c.json({ error: "Requête invalide." }, 400);
  }
  if (typeof input.emoji !== "string" || !reactionEmojis.has(input.emoji)) {
    return c.json({ error: "Réaction non prise en charge." }, 400);
  }
  await c.env.DB.prepare(
    `INSERT INTO reactions (id, media_id, member_id, emoji)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(media_id, member_id, emoji) DO NOTHING`,
  )
    .bind(crypto.randomUUID(), mediaId, c.get("member").id, input.emoji)
    .run();
  return c.json(await getReactionCounts(c, mediaId));
});

app.delete("/api/media/:id/reactions", async (c) => {
  const mediaId = c.req.param("id");
  let input: { emoji?: unknown };
  try {
    input = await c.req.json();
  } catch {
    return c.json({ error: "Requête invalide." }, 400);
  }
  if (typeof input.emoji !== "string" || !reactionEmojis.has(input.emoji)) {
    return c.json({ error: "Réaction non prise en charge." }, 400);
  }
  await c.env.DB.prepare(
    "DELETE FROM reactions WHERE media_id = ? AND member_id = ? AND emoji = ?",
  )
    .bind(mediaId, c.get("member").id, input.emoji)
    .run();
  return c.body(null, 204);
});

app.get("/api/measurements", async (c) => {
  const memberId = c.req.query("memberId");
  if (!isMemberId(memberId)) return c.json({ error: "Membre invalide." }, 400);
  if (memberId !== c.get("member").id) {
    return c.json({ error: "Ces mensurations appartiennent à un autre profil." }, 403);
  }
  const result = await c.env.DB.prepare(
    `SELECT id, member_id AS memberId, measured_at AS measuredAt, weight_kg AS weightKg,
            arm_cm AS armCm, chest_cm AS chestCm, waist_cm AS waistCm, thigh_cm AS thighCm
     FROM body_measurements WHERE member_id = ? ORDER BY measured_at DESC`,
  )
    .bind(memberId)
    .all();
  return c.json(result.results);
});

app.post("/api/measurements", async (c) => {
  let input: Record<string, unknown>;
  try {
    input = await c.req.json();
  } catch {
    return c.json({ error: "Requête invalide." }, 400);
  }
  if (input.memberId !== c.get("member").id || !validIsoDateTime(input.measuredAt)) {
    return c.json({ error: "Profil ou date invalide." }, 400);
  }
  const fields = ["weightKg", "armCm", "chestCm", "waistCm", "thighCm"] as const;
  const maximums = { weightKg: 500, armCm: 200, chestCm: 300, waistCm: 300, thighCm: 200 };
  for (const field of fields) {
    const value = input[field];
    if (value !== undefined && value !== null && (typeof value !== "number" || value < 0 || value > maximums[field])) {
      return c.json({ error: "Mensuration invalide." }, 400);
    }
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO body_measurements
     (id, member_id, measured_at, weight_kg, arm_cm, chest_cm, waist_cm, thigh_cm)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      c.get("member").id,
      input.measuredAt,
      input.weightKg ?? null,
      input.armCm ?? null,
      input.chestCm ?? null,
      input.waistCm ?? null,
      input.thighCm ?? null,
    )
    .run();
  const result = await c.env.DB.prepare(
    `SELECT id, member_id AS memberId, measured_at AS measuredAt, weight_kg AS weightKg,
            arm_cm AS armCm, chest_cm AS chestCm, waist_cm AS waistCm, thigh_cm AS thighCm
     FROM body_measurements WHERE id = ?`,
  )
    .bind(id)
    .first();
  return c.json(result, 201);
});

app.get("/api/storage", async (c) => {
  const usage = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(size_bytes), 0) AS used_bytes FROM media",
  ).first<{ used_bytes: number }>();
  return c.json({
    usedBytes: usage?.used_bytes ?? 0,
    limitBytes: readLimit(c.env.STORAGE_LIMIT_BYTES, storageLimitDefault, storageLimitDefault),
  });
});

app.get("/api/export", async (c) => {
  const [members, media, measurements, comments, reactions] = await Promise.all([
    c.env.DB.prepare("SELECT id, name, color_theme AS color FROM members ORDER BY id").all(),
    c.env.DB.prepare(
      `SELECT id, member_id AS memberId, taken_at AS takenAt, taken_date AS takenDate,
              caption, content_type AS contentType, size_bytes AS sizeBytes, tagged_users AS taggedMemberIds
       FROM media ORDER BY taken_at`,
    ).all(),
    c.env.DB.prepare(
      `SELECT id, member_id AS memberId, measured_at AS measuredAt, weight_kg AS weightKg,
              arm_cm AS armCm, chest_cm AS chestCm, waist_cm AS waistCm, thigh_cm AS thighCm
       FROM body_measurements ORDER BY measured_at`,
    ).all(),
    c.env.DB.prepare(
      `SELECT id, media_id AS mediaId, member_id AS memberId, text, created_at AS createdAt
       FROM comments ORDER BY created_at`,
    ).all(),
    c.env.DB.prepare(
      `SELECT id, media_id AS mediaId, member_id AS memberId, emoji, created_at AS createdAt
       FROM reactions ORDER BY created_at`,
    ).all(),
  ]);
  const exportedMedia = media.results.map((row) => {
    let taggedMemberIds: string[] = [];
    try {
      taggedMemberIds = JSON.parse(String(row.taggedMemberIds)) as string[];
    } catch {
      taggedMemberIds = [];
    }
    return { ...row, taggedMemberIds };
  });
  return c.json(
    {
      exportedAt: new Date().toISOString(),
      members: members.results,
      media: exportedMedia,
      measurements: measurements.results,
      comments: comments.results,
      reactions: reactions.results,
    },
    200,
    { "Content-Disposition": 'attachment; filename="souvenirs-physiques-export.json"' },
  );
});

app.notFound((c) => c.json({ error: "Route introuvable." }, 404));
app.onError((error, c) => {
  // The response stays generic; detailed exceptions must not expose bindings or photo keys.
  return c.json({ error: "Une erreur serveur est survenue." }, 500);
});

export const onRequest: PagesFunction<Env> = ({ request, env }) => app.fetch(request, env);