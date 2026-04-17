import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

const SAFETY_NOTICE_SECTIONS = [
  {
    title: '开始前确认',
    items: [
      '本项目会驱动设备输出波形，AI、浏览器、蓝牙、网络与桥接链路都可能出现异常或延迟。',
      '使用时请保持清醒，并确保你可以随时通过物理方式断开设备或停止输出。',
      '本项目不是医疗产品，也不能替代专业判断或风险评估。',
    ],
  },
  {
    title: '禁用与慎用',
    items: [
      '心脏起搏器、心血管疾病、癫痫、孕期或任何不确定身体状况时，请不要使用，或先咨询专业人士。',
      '禁止将电极放在胸口、头部、颈部、破损皮肤、炎症区域或任何异常敏感部位。',
      '独处、睡眠、洗澡、饮酒后、驾驶中或操作机械时，禁止使用。',
    ],
  },
  {
    title: '使用中要求',
    items: [
      '首次使用或更换部位时，请从最低强度开始，逐步确认体感与安全边界。',
      '输出期间不要移动电极，不要频繁切换贴片位置，也不要让导电部件短接。',
      '若出现刺痛、灼热、头晕、心悸或任何不适，请立刻停止并断开设备。',
    ],
  },
] as const;

interface SafetyNoticeModalProps {
  onAccept: (options: { dontShowAgain: boolean }) => void;
  countdownSeconds?: number;
}

export function SafetyNoticeModal({ onAccept, countdownSeconds = 10 }: SafetyNoticeModalProps) {
  const [remainingSeconds, setRemainingSeconds] = useState(countdownSeconds);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const acceptButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    document.body.classList.add('modal-open');
    return () => {
      document.body.classList.remove('modal-open');
    };
  }, []);

  useEffect(() => {
    if (remainingSeconds === 0) {
      acceptButtonRef.current?.focus();
      return;
    }

    const timer = window.setTimeout(() => {
      setRemainingSeconds((current) => Math.max(0, current - 1));
    }, 1_000);

    return () => window.clearTimeout(timer);
  }, [remainingSeconds]);

  return (
    <section className="permission-modal-backdrop safety-notice-backdrop">
      <article
        className="permission-modal safety-notice-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="safety-notice-title"
        aria-describedby="safety-notice-summary"
      >
        <header className="safety-notice-header">
          <div className="eyebrow safety-notice-eyebrow">DGLAB 安全确认</div>
          <h2 id="safety-notice-title">使用前安全确认</h2>
          <p id="safety-notice-summary" className="safety-notice-summary">
            继续之前，请确认你已经理解设备控制、AI 输出以及浏览器运行环境带来的风险，并能够随时主动停止。
          </p>
        </header>

        <div className="safety-notice-callout">
          <strong>AI 不是安全控制器。</strong>
          <span>模型可能误判，浏览器、蓝牙或桥接链路也可能卡顿、重试、断连或产生非预期行为。</span>
          <span>请始终把“立刻停止输出”和“立刻断开设备”放在最高优先级。</span>
        </div>

        <div className="safety-notice-grid">
          {SAFETY_NOTICE_SECTIONS.map((section) => (
            <section key={section.title} className="safety-notice-section">
              <h3>{section.title}</h3>
              <ul className="safety-notice-list">
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <footer className="safety-notice-footer">
          <div className="safety-notice-footer-copy">
            <strong>继续即表示你已阅读并愿意自行承担使用风险。</strong>
            <span>{remainingSeconds > 0 ? `请等待 ${remainingSeconds} 秒后确认。` : '倒计时结束，可以继续进入应用。'}</span>
            <label className="safety-notice-checkbox">
              <Checkbox checked={dontShowAgain} onCheckedChange={(checked) => setDontShowAgain(Boolean(checked))} />
              <span>下次启动时不再弹出这条安全确认</span>
            </label>
          </div>
          <Button
            ref={acceptButtonRef}
            disabled={remainingSeconds > 0}
            onClick={() => onAccept({ dontShowAgain })}
          >
            {remainingSeconds > 0 ? `我已阅读（${remainingSeconds}s）` : '我已阅读并继续'}
          </Button>
        </footer>
      </article>
    </section>
  );
}
