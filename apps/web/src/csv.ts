import type { LearnerImportRow, MemberImportRow } from '@iac/contracts';

/**
 * 批次匯入的 CSV 處理（純邏輯，有單元測試）。接受 Excel 存出的 UTF-8 CSV（含 BOM），
 * 也接受從 Excel 直接複製貼上（Tab 分隔）。
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const firstLine = src.split('\n', 1)[0] ?? '';
  const delim = firstLine.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

type Column = 'email' | 'displayName' | 'role' | 'courseCode' | 'memberNo' | 'cohort';

const HEADERS: Record<Column, string[]> = {
  email: ['email', 'e-mail', '電子郵件', '信箱', '電郵'],
  displayName: ['姓名', 'name', 'displayname', '名稱', '名字'],
  role: ['角色', 'role', '身分'],
  courseCode: ['課程代碼', 'coursecode', 'course', '課程', '課號'],
  memberNo: ['學號', '員工編號', '編號', '學生編號', 'memberno', 'studentid', 'studentno'],
  cohort: ['班級', '期別', '梯次', '班別', 'cohort', 'class', 'group'],
};

/** 中文角色名稱 → 代碼；無法辨識的原樣送出，由伺服器回報 invalid_role */
const ROLE_ALIASES: Record<string, string> = {
  學員: 'learner',
  學生: 'learner',
  講師: 'instructor',
  老師: 'instructor',
  教師: 'instructor',
  課程管理員: 'course_admin',
  組織管理員: 'org_admin',
  稽核人員: 'auditor',
};

function headerIndex(row: string[]): Partial<Record<Column, number>> | null {
  const norm = row.map((c) => c.toLowerCase().replace(/\s+/g, ''));
  const out: Partial<Record<Column, number>> = {};
  for (const [key, names] of Object.entries(HEADERS) as [Column, string[]][]) {
    const i = norm.findIndex((c) => names.includes(c));
    if (i >= 0) out[key] = i;
  }
  return out.email === undefined ? null : out;
}

/** 表格 → 成員列：有標題列時依標題對應欄位，否則依序為 Email、姓名、角色、課程代碼、學號、班級 */
export function toMemberRows(table: string[][]): MemberImportRow[] {
  const h = table[0] ? headerIndex(table[0]) : null;
  const idx = h ?? { email: 0, displayName: 1, role: 2, courseCode: 3, memberNo: 4, cohort: 5 };
  const body = h ? table.slice(1) : table;
  const at = (r: string[], i: number | undefined) => (i === undefined ? '' : (r[i] ?? ''));
  return body.map((r) => {
    const role = at(r, idx.role);
    const displayName = at(r, idx.displayName);
    const courseCode = at(r, idx.courseCode);
    const memberNo = at(r, idx.memberNo);
    const cohort = at(r, idx.cohort);
    return {
      email: at(r, idx.email),
      ...(displayName && { displayName }),
      ...(role && { role: ROLE_ALIASES[role] ?? role }),
      ...(courseCode && { courseCode }),
      ...(memberNo && { memberNo }),
      ...(cohort && { cohort }),
    };
  });
}

/** 表格 → 課程學員列：Email、姓名（選填） */
export function toLearnerRows(table: string[][]): LearnerImportRow[] {
  return toMemberRows(table).map((r) => ({ email: r.email, ...(r.displayName && { displayName: r.displayName }) }));
}

/** 範本（含 BOM，Excel 開啟不亂碼） */
export function csvTemplate(kind: 'members' | 'learners'): string {
  const lines =
    kind === 'members'
      ? [
          'Email,姓名,角色,課程代碼,學號,班級',
          'student01@example.com,王小明,學員,C-0001,S1130201,113 三年二班',
          'student02@example.com,李小華,學員,,S1130202,113 三年二班',
          'teacher01@example.com,陳老師,講師,C-0001,,',
        ]
      : ['Email,姓名', 'student01@example.com,王小明', 'student02@example.com,李小華'];
  return `﻿${lines.join('\r\n')}\r\n`;
}
