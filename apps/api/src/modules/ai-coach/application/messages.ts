import type { CoachAnswerStatus, CoachCitationDto, CoachMessageDto } from '@iac/contracts';
import type pg from 'pg';

/** 一段對話的訊息與引用（學員自己的對話與課程人員的逐字稿共用） */
export async function loadMessages(q: pg.Pool, conversationId: string): Promise<CoachMessageDto[]> {
  const msgs = await q.query<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    validation_status: string | null;
    policy_snapshot: { status?: CoachAnswerStatus; followUps?: string[] } | null;
    created_at: Date;
  }>(`SELECT id, role, content, validation_status, policy_snapshot, created_at FROM coach_messages WHERE conversation_id = $1 AND role IN ('user', 'assistant') ORDER BY seq_no`, [conversationId]);
  const cites = await q.query<{ id: string; message_id: string; citation_ref: string; title: string; page_no: number | null; section_path: string | null }>(
    `SELECT cc.id, cc.message_id, cc.citation_ref, cc.title, cc.page_no, cc.section_path
       FROM coach_citations cc JOIN coach_messages m ON m.id = cc.message_id WHERE m.conversation_id = $1 ORDER BY cc.citation_ref`,
    [conversationId],
  );
  const byMessage = new Map<string, CoachCitationDto[]>();
  for (const x of cites.rows) {
    const list = byMessage.get(x.message_id) ?? [];
    list.push({ id: x.id, citationId: x.citation_ref, title: x.title, pageNo: x.page_no, sectionPath: x.section_path, quote: null });
    byMessage.set(x.message_id, list);
  }
  return msgs.rows.map(
    (m): CoachMessageDto => ({
      id: m.id,
      role: m.role,
      content: m.content,
      status: m.role === 'assistant' ? (m.policy_snapshot?.status ?? (m.validation_status === 'fallback' ? 'fallback' : 'answered')) : null,
      citations: byMessage.get(m.id) ?? [],
      followUpQuestions: m.policy_snapshot?.followUps ?? [],
      createdAt: new Date(m.created_at).toISOString(),
    }),
  );
}
