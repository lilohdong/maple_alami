import { useState } from 'react';
import {
  DEFAULT_NOTIFY_PREFS,
  sendTest,
  subscribe,
  unsubscribe,
  updateSubscription,
  type NotifyPrefs,
  type SubscriptionPayload,
} from '../api/notify';
import type { Settings } from '../lib/storage';

interface Props {
  settings: Settings;
  onChange: (update: (prev: Settings) => Settings) => void;
}

const PREF_LABELS: { key: keyof NotifyPrefs; label: string; when: string }[] = [
  { key: 'weeklyBoss', label: '주간 보스', when: '수요일 18:00 · 목요일 리셋 6시간 전' },
  { key: 'weeklyContent', label: '주간 콘텐츠', when: '일요일 18:00 · 월요일 리셋 6시간 전' },
  { key: 'daily', label: '일일 콘텐츠', when: '매일 22:00 · 자정 리셋 2시간 전' },
];

export function buildPayload(settings: Settings, webhookUrl: string, prefs: NotifyPrefs): SubscriptionPayload {
  return {
    apiKey: settings.apiKey,
    webhookUrl,
    characters: settings.tracked.map((c) => c.ocid),
    party: settings.party,
    prefs,
  };
}

export function NotifyPanel({ settings, onChange }: Props) {
  const sub = settings.notify;
  const [webhookUrl, setWebhookUrl] = useState(sub?.webhookUrl ?? '');
  const [inviteCode, setInviteCode] = useState('');
  const [prefs, setPrefs] = useState<NotifyPrefs>(sub?.prefs ?? DEFAULT_NOTIFY_PREFS);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ kind: 'ok', text: await action() });
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : '오류가 발생했습니다.' });
    } finally {
      setBusy(false);
    }
  };

  const enable = () =>
    run(async () => {
      const url = webhookUrl.trim();
      const created = await subscribe({ ...buildPayload(settings, url, prefs), inviteCode: inviteCode.trim() });
      onChange((prev) => ({ ...prev, notify: { ...created, webhookUrl: url, prefs } }));
      return '알림을 켰습니다. 디스코드 채널에 연결 메시지가 도착했는지 확인해주세요.';
    });

  const save = () =>
    run(async () => {
      if (!sub) return '';
      const url = webhookUrl.trim();
      await updateSubscription(sub, buildPayload(settings, url, prefs));
      onChange((prev) => ({ ...prev, notify: { ...sub, webhookUrl: url, prefs } }));
      return '저장했습니다.';
    });

  const test = () =>
    run(async () => {
      if (!sub) return '';
      await sendTest(sub);
      return '현재 진행 현황을 디스코드로 보냈습니다.';
    });

  const disable = () =>
    run(async () => {
      if (!sub) return '';
      // 서버에 이미 없더라도 로컬 정보는 지움
      await unsubscribe(sub).catch(() => undefined);
      onChange((prev) => ({ ...prev, notify: undefined }));
      return '알림을 껐습니다.';
    });

  const canEnable = webhookUrl.trim() && settings.apiKey && settings.tracked.length > 0;

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>디스코드 알림</h2>
        {sub && <span className="status-pill">켜짐</span>}
      </div>
      <p className="hint">
        리셋 전에 남은 할일을 디스코드 채널로 보내드립니다. 알림을 보내기 위해 API 키와 웹훅 주소가 알림 서버에 암호화되어
        저장되며, 알림을 끄면 즉시 삭제됩니다.
      </p>

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

      {!sub && (
        <label className="field">
          <span>초대 코드</span>
          <input type="text" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="관리자에게 받은 코드" autoComplete="off" />
        </label>
      )}

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

      {message && <p className={message.kind === 'error' ? 'error' : 'ok-text'}>{message.text}</p>}

      <div className="panel-actions">
        {sub ? (
          <>
            <button onClick={disable} disabled={busy}>
              알림 끄기
            </button>
            <button onClick={test} disabled={busy}>
              지금 현황 보내기
            </button>
            <button className="primary" onClick={save} disabled={busy || !webhookUrl.trim()}>
              저장
            </button>
          </>
        ) : (
          <button className="primary" onClick={enable} disabled={busy || !canEnable}>
            {busy ? '연결 중…' : '알림 켜기'}
          </button>
        )}
      </div>
      {!settings.apiKey && <p className="hint">먼저 설정에서 API 키와 캐릭터를 등록해주세요.</p>}
    </section>
  );
}
