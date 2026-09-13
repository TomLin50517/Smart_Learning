import {
  ACTIVITY_TYPES,
  COACH_KNOWLEDGE_SCOPES,
  COACH_LANGUAGES,
  COACH_POLICY_LIMITS,
  COACH_RESPONSE_MODES,
  COACH_TONE_PROFILES,
  COURSE_LIMITS,
  COURSE_STAFF_ROLES,
  NAVIGATION_MODES,
  RULE_GRAMMAR_VERSION,
} from '@iac/contracts';
import { z } from 'zod';

/**
 * 課程相關的輸入驗證（SD §6.5）。refine 的 message 為固定 issue 代碼（見 common/validation.ts）。
 * 結構性規則（id 唯一、區塊引用、跨版本衝突、互動元件存在）需要查 DB，於 CourseService 檢查。
 */
const Id = z.guid();
const Title = z.string().trim().min(1).max(200);

/** 任意 JSON 物件，限制序列化後大小 */
const JsonObject = z
  .record(z.string(), z.unknown())
  .refine((v) => JSON.stringify(v).length <= COURSE_LIMITS.jsonBytes, 'json_too_large');

const Block = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('richtext'), markdown: z.string().max(COURSE_LIMITS.markdownChars) }),
  z.strictObject({ type: z.literal('image'), assetId: Id, alt: z.string().trim().min(1).max(300), caption: z.string().max(500).optional() }),
  z.strictObject({ type: z.literal('video'), assetId: Id, poster: Id.optional() }),
  z.strictObject({ type: z.literal('callout'), variant: z.enum(['info', 'warning', 'success']), body: z.string().max(5000) }),
  z.strictObject({ type: z.literal('activity'), activityId: Id }),
]);

export const ActivityInput = z
  .strictObject({
    id: Id,
    title: Title,
    activityType: z.enum(ACTIVITY_TYPES),
    interactiveDefinitionId: Id.nullable().default(null),
    config: JsonObject.default({}),
    answerKey: JsonObject.nullable().default(null),
    isRequired: z.boolean().default(true),
    maxAttempts: z.number().int().min(1).max(100).nullable().default(null),
    weight: z.number().min(0).max(999).default(1),
    maxScore: z.number().positive().max(100_000).default(100),
    prerequisite: JsonObject.nullable().default(null),
  })
  .refine((a) => a.activityType !== 'interactive' || a.interactiveDefinitionId !== null, {
    message: 'interactive_requires_definition',
    path: ['interactiveDefinitionId'],
  });

export const LessonInput = z.strictObject({
  id: Id,
  title: Title,
  isRequired: z.boolean().default(true),
  contentBlocks: z.array(Block).max(COURSE_LIMITS.blocksPerLesson).default([]),
  activities: z.array(ActivityInput).max(COURSE_LIMITS.activitiesPerLesson).default([]),
});

export const ModuleInput = z.strictObject({
  id: Id,
  title: Title,
  description: z.string().max(2000).nullable().default(null),
  isRequired: z.boolean().default(true),
  lessons: z.array(LessonInput).max(COURSE_LIMITS.lessonsPerModule).default([]),
});

export type ModuleInputT = z.infer<typeof ModuleInput>;

export const DraftPatch = z
  .strictObject({
    title: Title.optional(),
    summary: z.string().max(5000).nullable().optional(),
    navigationMode: z.enum(NAVIGATION_MODES).optional(),
    /** 整組取代課程結構；既有項目以 id 保留（完成條件以 id 引用活動），新項目由前端產生 UUID */
    modules: z.array(ModuleInput).max(COURSE_LIMITS.modules).optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'nothing_to_update');

export type DraftPatchT = z.infer<typeof DraftPatch>;

export const CreateCourse = z.strictObject({
  /** 選填：留空時由伺服器依組織自動編號（C-0001 起，SD §6.5） */
  code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'invalid_code').optional(),
  title: Title,
  description: z.string().max(5000).optional(),
});

/** PATCH /courses/{id}：權限為 course.archive、稽核為 course.archived——只做封存 */
export const ArchiveCourse = z.strictObject({ status: z.literal('archived') });

export const CreateVersion = z.strictObject({
  title: Title,
  summary: z.string().max(5000).optional(),
  navigationMode: z.enum(NAVIGATION_MODES).default('mixed'),
});

export const AssignStaff = z.strictObject({
  email: z.email().max(254),
  role: z.enum(COURSE_STAFF_ROLES),
});

/**
 * PUT /course-versions/{id}/completion-rules。rule 的語法由 @iac/domain 的 validateRule 檢查
 * （需要課程結構，故在 service 內）；此處只限大小。null＝清除完成條件。
 */
export const CompletionRulesInput = z.strictObject({
  grammarVersion: z.literal(RULE_GRAMMAR_VERSION).default(RULE_GRAMMAR_VERSION),
  rule: JsonObject.nullable(),
});

/** PUT /course-versions/{id}/coach-policy：整組取代。值域白名單——這些值會組進 AI 提示詞（SD §10.1.2） */
export const CoachPolicyInput = z.strictObject({
  responseMode: z.enum(COACH_RESPONSE_MODES),
  maxDirectnessLevel: z.number().int().min(1).max(5),
  allowAnswerRevealAfterAttempts: z.number().int().min(1).max(COACH_POLICY_LIMITS.revealAfterMax).nullable(),
  preferredLanguage: z.enum(COACH_LANGUAGES),
  citationRequired: z.boolean(),
  allowedKnowledgeScopes: z
    .array(z.enum(COACH_KNOWLEDGE_SCOPES))
    .min(1)
    .refine((v) => new Set(v).size === v.length, 'duplicate'),
  toneProfile: z.enum(COACH_TONE_PROFILES),
  followUpQuestions: z.boolean(),
  prohibitedTopics: z.array(z.string().trim().min(1).max(COACH_POLICY_LIMITS.topicChars)).max(COACH_POLICY_LIMITS.prohibitedTopics),
  extraInstructions: z
    .string()
    .trim()
    .max(COACH_POLICY_LIMITS.extraInstructionsChars)
    .nullable()
    .transform((v) => v || null),
});

export const CoursePaging = z.object({
  /** 只列某組織的課程（仍受 course.read 範圍限制；供成員頁的課程選單使用） */
  organizationId: Id.optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
