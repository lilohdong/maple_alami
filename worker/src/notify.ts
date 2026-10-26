// 스케줄러 상태로 디스코드 알림 메시지를 만든다.
// 구성: 요약 임베드 1개 + 남은 할일이 있는 캐릭터별 임베드 (디스코드 제한: 메시지당 임베드 10개)

import type { CharacterStateResponse, SchedulerContent } from '../../src/api/nexon';
import { formatMeso, normalizeDifficulty } from '../../src/data/crystals';
import { bossShare, isBossDone, isContentDone, normalizeCycle, type PartySizes } from '../../src/lib/progress';
import { nextReset, type ResetKind } from '../../src/lib/reset';

export type NotifyKind = 'weeklyBoss' | 'weeklyContent' | 'daily' | 'status';

export interface Prefs {
  weeklyBoss: boolean;
  weeklyContent: boolean;
  daily: boolean;
}

export const DEFAULT_PREFS: Prefs = { weeklyBoss: true, weeklyContent: true, daily: true };

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 크론 실행 시각(KST)에 보낼 알림 종류 */
export function dueKinds(scheduledTime: number): NotifyKind[] {
  const kst = new Date(scheduledTime + KST_OFFSET_MS);
  const hour = kst.getUTCHours();
  const day = kst.getUTCDay();
  const kinds: NotifyKind[] = [];
  if (hour === 18 && day === 3) kinds.push('weeklyBoss'); // 수 18시 → 목 00시 리셋 6시간 전
  if (hour === 18 && day === 0) kinds.push('weeklyContent'); // 일 18시 → 월 00시 리셋 6시간 전
  if (hour === 22) kinds.push('daily'); // 매일 22시 → 자정 리셋 2시간 전
  return kinds;
}

export interface CharacterReport {
  ocid: string;
  state: CharacterStateResponse | null;
  error?: string;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color: number;
  thumbnail?: { url: string };
  footer?: { text: string };
  timestamp?: string;
}

const COLOR = { orange: 0xf28c28, green: 0x3ccf8e, gray: 0x4f5563 };
const MAX_EMBEDS = 10;
const MAX_DESCRIPTION = 4000;

const META: Record<NotifyKind, { title: string; reset?: ResetKind }> = {
  weeklyBoss: { title: '⚔️ 주간 보스 리셋 알림', reset: 'weeklyBoss' },
  weeklyContent: { title: '📅 주간 콘텐츠 리셋 알림', reset: 'weeklyContent' },
  daily: { title: '🌙 일일 콘텐츠 리셋 알림', reset: 'daily' },
  status: { title: '📋 현재 진행 현황' },
};

const registered = <T extends { registration_flag: string }>(items: T[] | null | undefined) =>
  (items ?? []).filter((i) => i.registration_flag === 'true');

const hasData = (s: CharacterStateResponse) =>
  (s.boss_contents?.length ?? 0) + (s.daily_contents?.length ?? 0) + (s.weekly_contents?.length ?? 0) > 0;

/** 디스코드가 보는 사람 시간대로 바꿔 보여주는 시각 표기 */
const discordTime = (ms: number, style: 'R' | 'f' | 't') => `<t:${Math.floor(ms / 1000)}:${style}>`;

interface Section {
  /** 섹션 제목 줄 */
  heading: string;
  /** 남은 항목 줄 */
  lines: string[];
  /** 요약 집계용 */
  count: number;
  meso: number;
}

function bossSection(s: CharacterStateResponse, party: PartySizes | undefined): Section | null {
  const limit = s.weekly_boss_clear_limit_count;
  if (limit > 0 && s.weekly_boss_clear_count >= limit) return null;
  const left = registered(s.boss_contents).filter((b) => normalizeCycle(b.cycle) === 'weekly' && !isBossDone(b));
  if (left.length === 0) return null;

  // 판매 제한(limit) 안에서 남은 슬롯만큼 비싼 순으로 결정석 합산
  const slots = Math.max(0, (limit || 12) - s.weekly_boss_clear_count);
  const shares = left.map((b) => ({ b, v: bossShare(b, party) })).sort((a, b) => (b.v ?? 0) - (a.v ?? 0));
  const meso = shares.slice(0, slots).reduce((sum, { v }) => sum + (v ?? 0), 0);

  return {
    heading: `⚔️ **주간 보스** · \`${s.weekly_boss_clear_count}/${limit}\` 처치 · 남은 결정석 **${formatMeso(meso)}**`,
    lines: shares.map(({ b, v }) => `\`${normalizeDifficulty(b.difficulty)}\` ${b.content_name}${v !== null ? ` · ${formatMeso(v)}` : ''}`),
    count: left.length,
    meso,
  };
}

function contentStatus(c: SchedulerContent): string {
  if (c.type === 'quest') return c.quest_state === '1' ? ' · 진행 중' : '';
  return c.max_count > 0 ? ` · \`${c.now_count}/${c.max_count}\`` : '';
}

function contentSection(icon: string, label: string, items: SchedulerContent[] | null | undefined): Section | null {
  const all = registered(items);
  const left = all.filter((c) => !isContentDone(c));
  if (left.length === 0) return null;
  return {
    heading: `${icon} **${label}** · ${left.length}개 남음 \`${all.length - left.length}/${all.length}\``,
    lines: left.map((c) => `${c.content_name}${contentStatus(c)}`),
    count: left.length,
    meso: 0,
  };
}

function sectionsFor(kind: NotifyKind, s: CharacterStateResponse, party: PartySizes | undefined): Section[] {
  const daily = () => contentSection('🌙', '일일', s.daily_contents);
  const weekly = () => contentSection('📅', '주간 콘텐츠', s.weekly_contents);
  const list =
    kind === 'weeklyBoss' ? [bossSection(s, party)] :
    kind === 'weeklyContent' ? [weekly()] :
    kind === 'daily' ? [daily()] :
    [bossSection(s, party), daily(), weekly()];
  return list.filter((x): x is Section => x !== null);
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function characterEmbed(s: CharacterStateResponse, sections: Section[], image: string | undefined): DiscordEmbed {
  const body = sections.map((sec) => [sec.heading, ...sec.lines.map((l) => `> ${l}`)].join('\n')).join('\n\n');
  return {
    title: `${s.character_name}`,
    description: clip(`Lv.${s.character_level} · ${s.character_class} · ${s.world_name}\n\n${body}`, MAX_DESCRIPTION),
    color: COLOR.orange,
    ...(image ? { thumbnail: { url: image } } : {}),
  };
}

/** 남은 할일이 없으면 null (status는 항상 메시지 생성) */
export function buildEmbeds(
  kind: NotifyKind,
  reports: CharacterReport[],
  party: Record<string, PartySizes>,
  images: Record<string, string> = {},
  now = Date.now(),
): DiscordEmbed[] | null {
  const pending: DiscordEmbed[] = [];
  const done: string[] = [];
  const notLoggedIn: string[] = [];
  const failed: string[] = [];
  let count = 0;
  let meso = 0;

  for (const r of reports) {
    if (!r.state) {
      failed.push(r.error ?? '조회 실패');
      continue;
    }
    // 스케줄러는 접속해야 갱신되어 오늘 미접속 캐릭터는 데이터가 비어 있음 → 완료로 오인하지 않도록 따로 표시
    if (!hasData(r.state)) {
      notLoggedIn.push(r.state.character_name);
      continue;
    }
    const sections = sectionsFor(kind, r.state, party[r.ocid]);
    if (sections.length === 0) {
      done.push(r.state.character_name);
      continue;
    }
    count += sections.reduce((n, sec) => n + sec.count, 0);
    meso += sections.reduce((n, sec) => n + sec.meso, 0);
    pending.push(characterEmbed(r.state, sections, images[r.ocid]));
  }

  if (kind !== 'status' && pending.length === 0 && notLoggedIn.length === 0 && failed.length === 0) return null;

  const meta = META[kind];
  const lines: string[] = [];
  if (meta.reset) {
    const reset = nextReset(meta.reset, now);
    lines.push(`리셋 ${discordTime(reset, 'R')} · ${discordTime(reset, 'f')}`, '');
  }
  if (pending.length > 0) {
    lines.push(`📌 남은 할일 **${count}개**${meso > 0 ? ` · 남은 결정석 **${formatMeso(meso)}**` : ''}`);
  } else if (notLoggedIn.length === 0 && failed.length === 0) {
    lines.push('🎉 남은 할일이 없습니다!');
  }
  if (done.length > 0) lines.push(`✅ 완료 · ${done.join(', ')}`);
  if (notLoggedIn.length > 0) lines.push(`💤 오늘 미접속 · ${notLoggedIn.join(', ')}`);
  if (failed.length > 0) lines.push(`⚠️ 조회 실패 · ${[...new Set(failed)].join(', ')}`);

  const shown = pending.slice(0, MAX_EMBEDS - 1);
  if (pending.length > shown.length) lines.push(`… 외 ${pending.length - shown.length}캐릭터`);

  const summary: DiscordEmbed = {
    title: meta.title,
    description: clip(lines.join('\n'), MAX_DESCRIPTION),
    color: pending.length > 0 ? COLOR.orange : COLOR.green,
    footer: { text: '메이플 할일 알리미' },
    timestamp: new Date(now).toISOString(),
  };
  return [summary, ...shown];
}
