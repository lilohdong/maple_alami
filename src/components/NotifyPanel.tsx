import { useEffect, useState } from 'react';
import {
  BOT_INVITE_URL,
  DEFAULT_NOTIFY_PREFS,
  DISCORD_APP_ID,
  getSubscription,
  newLinkCode,
  NotifyApiError,
  sendTest,
  subscribe,
  unsubscribe,
  updateSubscription,
  type Destination,
  type NotifyPrefs,
  type SubscriptionPayload,
} from '../api/notify';
import type { NotifySettings, Settings } from '../lib/storage';

interface Props {
  settings: Settings;
  onChange: (update: (prev: Settings) => Settings) => void;
}

const BOT_MODE = Boolean(DISCORD_APP_ID);
const LINK_CODE_TTL_MS = 30 * 60 * 1000;
const POLL_MS = 4000;

const PREF_LABELS: { key: keyof NotifyPrefs; label: string; when: string }[] = [
  { key: 'weeklyBoss', label: '주간 보스', when: '수요일 18:00 · 목요일 리셋 6시간 전' },
  { key: 'weeklyContent', label: '주간 콘텐츠', when: '수요일 18:00 · 주간 보스 알림과 함께' },
  { key: 'daily', label: '일일 콘텐츠', when: '매일 22:00 · 자정 리셋 2시간 전' },
];

export function buildPayload(settings: Settings, prefs: NotifyPrefs, webhookUrl?: string): SubscriptionPayload {
  return {
    apiKey: settings.apiKey,
    webhookUrl,
    characters: settings.tracked.map((c) => c.ocid),
    party: settings.party,
    images: Object.fromEntries(settings.tracked.flatMap((c) => (c.character_image ? [[c.ocid, c.character_image]] : []))),
    prefs,
  };
}

const withCode = (code: string): NotifySettings['linkCode'] => ({ code, expiresAt: Date.now() + LINK_CODE_TTL_MS });

export function NotifyPanel({ settings, onChange }: Props) {
  const sub = settings.notify;
  const [webhookUrl, setWebhookUrl] = useState(sub?.webhookUrl ?? '');
  const [inviteCode, setInviteCode] = useState('');
  const [prefs, setPrefs] = useState<NotifyPrefs>(sub?.prefs ?? DEFAULT_NOTIFY_PREFS);
  const [destination, setDestination] = useState<Destination | 'loading'>(sub ? 'loading' : null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const setNotify = (update: (n: NotifySettings) => NotifySettings | undefined) =>
    onChange((prev) => ({ ...prev, notify: prev.notify ? update(prev.notify) : undefined }));

  const code = sub?.linkCode && sub.linkCode.expiresAt > Date.now() ? sub.linkCode.code : null;
  // 봇 연결 대기: 아직 연결 전이거나, 웹훅에서 봇으로 전환하려고 코드를 받은 상태
  const waitingForLink = BOT_MODE && !!sub && (destination === null || (destination === 'webhook' && !!code));

  // 연결 상태 확인. 연결 코드를 보여주는 동안에는 /연결 될 때까지 주기적으로 확인
  useEffect(() => {
    if (!sub) return;
    let cancelled = false;
    const check = () =>
      getSubscription(sub)
        .then((s) => {
          if (cancelled) return;
          setDestination(s.destination);
          if (s.destination === 'discord') setNotify((n) => ({ ...n, webhookUrl: undefined, linkCode: undefined }));
        })
        .catch((e) => {
          // 서버에서 삭제됨 (디스코드에서 /해제 등) → 로컬 정보도 정리
          if (!cancelled && e instanceof NotifyApiError && e.status === 404) onChange((prev) => ({ ...prev, notify: undefined }));
        });
    check();
    const timer = waitingForLink ? setInterval(check, POLL_MS) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // sub.id가 바뀌거나 연결 대기 상태가 바뀔 때만 다시 시작
  }, [sub?.id, waitingForLink]);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await action();
      if (text) setMessage({ kind: 'ok', text });
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : '오류가 발생했습니다.' });
    } finally {
      setBusy(false);
    }
  };

  const enable = () =>
    run(async () => {
      const url = BOT_MODE ? undefined : webhookUrl.trim();
      const created = await subscribe({ ...buildPayload(settings, prefs, url), inviteCode: inviteCode.trim() });
      onChange((prev) => ({
        ...prev,
        notify: { id: created.id, token: created.token, webhookUrl: url, prefs, linkCode: created.linkCode ? withCode(created.linkCode) : undefined },
      }));
      setDestination(url ? 'webhook' : null);
      return url ? '알림을 켰습니다. 디스코드 채널에 연결 메시지가 도착했는지 확인해주세요.' : '';
    });

  const save = () =>
    run(async () => {
      if (!sub) return '';
      const url = destination === 'webhook' ? webhookUrl.trim() || undefined : undefined;
      await updateSubscription(sub, buildPayload(settings, prefs, url));
      setNotify((n) => ({ ...n, webhookUrl: url, prefs }));
      return '저장했습니다.';
    });

  const test = () =>
    run(async () => {
      if (!sub) return '';
      await sendTest(sub);
      return '현재 진행 현황을 디스코드로 보냈습니다.';
    });

  const refreshCode = () =>
    run(async () => {
      if (!sub) return '';
      const { linkCode } = await newLinkCode(sub);
      setNotify((n) => ({ ...n, linkCode: withCode(linkCode) }));
      setDestination((d) => (d === 'loading' ? null : d));
      return '';
    });

  const disable = () =>
    run(async () => {
      if (!sub) return '';
      // 서버에 이미 없더라도 로컬 정보는 지움
      await unsubscribe(sub).catch(() => undefined);
      onChange((prev) => ({ ...prev, notify: undefined }));
      setDestination(null);
      return '알림을 껐습니다.';
    });

  const ready = settings.apiKey && settings.tracked.length > 0;

  const prefsBox = (
    <fieldset className="prefs">
      <legend>받을 알림</legend>
      {PREF_LABELS.map(({ key, label, when }) => (
        <label key={key} className="pref">
          <input type="checkbox" checked={prefs[key]} onChange={(e) => setPrefs({ ...prefs, [key]: e.target.checked })} />
          <span className="pref-label">{label}</span>
          <span className="muted">{when}</span>
        </label>
      ))}
      <p className="hint">남은 할일이 없으면 알림을 보내지 않습니다. 대시보드에 표시 중인 캐릭터가 대상입니다.</p>
    </fieldset>
  );

  const webhookField = (
    <>
      <label className="field">
        <span>디스코드 웹훅 주소</span>
        <input
          type="password"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          placeholder="https://discord.com/api/webhooks/..."
          autoComplete="off"
        />
      </label>
      <details className="help">
        <summary>웹훅 주소 만드는 법</summary>
        <ol>
          <li>알림 받을 디스코드 채널의 ⚙️ 채널 편집 → 연동 → 웹후크</li>
          <li>새 웹후크 만들기 → 웹후크 URL 복사</li>
          <li>복사한 주소를 위에 붙여넣기</li>
        </ol>
      </details>
    </>
  );

  const linked = destination === 'discord' || destination === 'webhook';

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>디스코드 알림</h2>
        {linked && <span className="status-pill">{destination === 'discord' ? '봇 연결됨' : '웹훅 연결됨'}</span>}
        {waitingForLink && <span className="status-pill waiting">연결 대기 중</span>}
      </div>
      <p className="hint">
        리셋 전에 남은 할일을 디스코드로 알려드립니다. 알림을 위해 API 키가 알림 서버에 암호화되어 저장되며, 알림을 끄면 즉시
        삭제됩니다.
      </p>

      {/* 1. 아직 안 켬 */}
      {!sub && (
        <>
          {!BOT_MODE && webhookField}
          <label className="field">
            <span>초대 코드</span>
            <input type="text" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="관리자에게 받은 코드" autoComplete="off" />
          </label>
          {prefsBox}
        </>
      )}

      {/* 2. 봇 연결 대기: 연결 코드 안내 */}
      {sub && waitingForLink && (
        <div className="link-box">
          {code ? (
            <>
              <p>알림 받을 디스코드 채널에 아래 명령을 입력하세요.</p>
              <code className="link-command">/연결 {code}</code>
              <p className="hint">
                코드는 {new Date(sub.linkCode!.expiresAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}까지
                유효합니다. 입력하면 이 화면이 자동으로 바뀝니다.
              </p>
            </>
          ) : (
            <p>연결 코드가 만료되었습니다. 새 코드를 받아주세요.</p>
          )}
          {BOT_INVITE_URL && (
            <p className="hint">
              서버에 봇이 아직 없다면 서버 관리자가{' '}
              <a href={BOT_INVITE_URL} target="_blank" rel="noreferrer">
                봇 초대하기
              </a>
              로 먼저 초대해야 합니다.
            </p>
          )}
        </div>
      )}

      {/* 3. 연결됨: 설정 변경 */}
      {sub && linked && !waitingForLink && (
        <>
          {destination === 'webhook' && webhookField}
          {destination === 'discord' && <p className="hint">디스코드에서 <code>/현황</code>으로 언제든 현재 숙제 현황을 볼 수 있고, <code>/해제</code>로 알림을 끌 수 있습니다.</p>}
          {prefsBox}
        </>
      )}

      {message && <p className={message.kind === 'error' ? 'error' : 'ok-text'}>{message.text}</p>}

      <div className="panel-actions">
        {!sub && (
          <button className="primary" onClick={enable} disabled={busy || !ready || (!BOT_MODE && !webhookUrl.trim())}>
            {busy ? '연결 중…' : '알림 켜기'}
          </button>
        )}
        {sub && (
          <button onClick={disable} disabled={busy}>
            알림 끄기
          </button>
        )}
        {sub && waitingForLink && (
          <button className={code ? '' : 'primary'} onClick={refreshCode} disabled={busy}>
            새 코드 받기
          </button>
        )}
        {sub && destination === 'webhook' && BOT_MODE && !waitingForLink && (
          <button onClick={refreshCode} disabled={busy} title="웹훅 대신 봇으로 받기">
            봇으로 전환
          </button>
        )}
        {sub && linked && !waitingForLink && (
          <>
            <button onClick={test} disabled={busy}>
              지금 현황 보내기
            </button>
            <button className="primary" onClick={save} disabled={busy}>
              저장
            </button>
          </>
        )}
      </div>
      {!ready && <p className="hint">먼저 설정에서 API 키와 캐릭터를 등록해주세요.</p>}
    </section>
  );
}
