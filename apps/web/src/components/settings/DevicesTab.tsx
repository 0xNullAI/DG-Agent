import { SettingToggle } from './SettingToggle.js';

export interface DevicesTabProps {
  sensorTriggersEnabled: boolean;
  onToggleSensorTriggers: (enabled: boolean) => void;
}

export function DevicesTab({ sensorTriggersEnabled, onToggleSensorTriggers }: DevicesTabProps) {
  return (
    <div className="settings-panel-tab-content">
      <section className="settings-row-section">
        <div className="settings-row-card grid gap-3">
          <h3 className="settings-card-legend">传感器触发</h3>
          <p className="text-[12px] leading-relaxed text-[var(--text-faint)]">
            开启后，爪印按键触发或灵猫压力明显变化会作为内部提醒推送给
            AI，由它自行判断是否响应；不会自动改变设备状态。默认关闭。
          </p>
          <SettingToggle
            label="允许传感器事件驱动 AI 主动响应"
            checked={sensorTriggersEnabled}
            onCheckedChange={onToggleSensorTriggers}
          />
        </div>
      </section>
    </div>
  );
}
