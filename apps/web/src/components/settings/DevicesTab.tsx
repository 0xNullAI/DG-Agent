import { useState } from 'react';
import {
  Battery,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  Bluetooth,
  BluetoothOff,
} from 'lucide-react';
import type { SensorState } from '@dg-agent/core';
import { createEmptySensorState } from '@dg-agent/core';
import { createEmptyOpossumState, type OpossumState } from '@dg-agent/device-webbluetooth';
import type { CivetEdgingClient, OpossumClient, PawPrintsClient } from '@dg-agent/runtime';
import { Button } from '@/components/ui/button';
import { useAuxDeviceState } from '../../hooks/use-aux-device-state.js';
import { isBluetoothChooserCancelledError } from '../../utils/ui-formatters.js';
import { SettingToggle } from './SettingToggle.js';

export interface DevicesTabProps {
  opossum: OpossumClient;
  pawPrints: PawPrintsClient;
  civetEdging: CivetEdgingClient;
  sensorTriggersEnabled: boolean;
  onToggleSensorTriggers: (enabled: boolean) => void;
}

type AuxDeviceKind = 'opossum' | 'paw-prints' | 'civet-edging';

function BatteryIcon({ level }: { level: number | null | undefined }) {
  if (level == null) return <Battery className="h-3.5 w-3.5 text-[var(--text-faint)]" />;
  if (level <= 10) return <BatteryWarning className="h-3.5 w-3.5 text-[var(--danger)]" />;
  if (level <= 30) return <BatteryLow className="h-3.5 w-3.5 text-[var(--warning)]" />;
  if (level <= 70) return <BatteryMedium className="h-3.5 w-3.5 text-[var(--text-soft)]" />;
  return <BatteryFull className="h-3.5 w-3.5 text-[var(--success)]" />;
}

interface AuxDeviceRowProps {
  title: string;
  description: string;
  connected: boolean;
  deviceName?: string;
  battery: number | null | undefined;
  connecting: boolean;
  error: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}

function AuxDeviceRow({
  title,
  description,
  connected,
  deviceName,
  battery,
  connecting,
  error,
  onConnect,
  onDisconnect,
}: AuxDeviceRowProps) {
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--surface-border)] px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
            {connected ? (
              <Bluetooth className="h-3.5 w-3.5 shrink-0 text-[var(--success)]" />
            ) : (
              <BluetoothOff className="h-3.5 w-3.5 shrink-0 text-[var(--text-faint)]" />
            )}
            <span className="truncate">{title}</span>
          </div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-faint)]">
            {connected ? (deviceName ? `已连接：${deviceName}` : '已连接') : description}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {connected && (
            <span className="flex items-center gap-1 text-[11px] tabular-nums text-[var(--text-soft)]">
              <BatteryIcon level={battery} />
              {typeof battery === 'number' ? `${battery}%` : '--'}
            </span>
          )}
          <Button
            variant={connected ? 'secondary' : 'default'}
            size="sm"
            className="h-7 rounded-[8px] px-2.5 text-[12px]"
            disabled={connecting}
            onClick={connected ? onDisconnect : onConnect}
          >
            {connecting ? '连接中…' : connected ? '断开' : '连接'}
          </Button>
        </div>
      </div>
      {error && <p className="text-[12px] leading-relaxed text-[var(--danger)]">{error}</p>}
    </div>
  );
}

export function DevicesTab({
  opossum,
  pawPrints,
  civetEdging,
  sensorTriggersEnabled,
  onToggleSensorTriggers,
}: DevicesTabProps) {
  const opossumState = useAuxDeviceState<OpossumState>(opossum, createEmptyOpossumState());
  const pawPrintsState = useAuxDeviceState<SensorState>(pawPrints, createEmptySensorState());
  const civetEdgingState = useAuxDeviceState<SensorState>(civetEdging, createEmptySensorState());

  const [connectingKind, setConnectingKind] = useState<AuxDeviceKind | null>(null);
  const [errors, setErrors] = useState<Record<AuxDeviceKind, string | null>>({
    opossum: null,
    'paw-prints': null,
    'civet-edging': null,
  });

  async function handleConnect(
    kind: AuxDeviceKind,
    client: OpossumClient | PawPrintsClient | CivetEdgingClient,
  ): Promise<void> {
    setConnectingKind(kind);
    setErrors((current) => ({ ...current, [kind]: null }));
    try {
      await client.connect();
    } catch (error) {
      if (!isBluetoothChooserCancelledError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        setErrors((current) => ({ ...current, [kind]: message }));
      }
    } finally {
      setConnectingKind((current) => (current === kind ? null : current));
    }
  }

  async function handleDisconnect(
    kind: AuxDeviceKind,
    client: OpossumClient | PawPrintsClient | CivetEdgingClient,
  ): Promise<void> {
    try {
      await client.disconnect();
      setErrors((current) => ({ ...current, [kind]: null }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrors((current) => ({ ...current, [kind]: message }));
    }
  }

  return (
    <div className="settings-panel-tab-content">
      <section className="settings-row-section">
        <div className="settings-row-card grid gap-3">
          <h3 className="settings-card-legend">扩展设备</h3>
          <p className="text-[12px] leading-relaxed text-[var(--text-faint)]">
            聊天界面顶部的连接按钮会自动识别并连接郊狼或以下任意扩展设备，重复点击可依次添加多个。也可以在这里单独连接某一种设备——三者各自独立连接/断开，互不影响，也不会影响郊狼的连接状态。
          </p>

          <AuxDeviceRow
            title="负鼠振动控制器"
            description="双通道振动 + 指示灯颜色，连接后 AI 可使用振动相关工具。"
            connected={opossumState.connected}
            deviceName={opossumState.deviceName}
            battery={opossumState.battery}
            connecting={connectingKind === 'opossum'}
            error={errors.opossum}
            onConnect={() => void handleConnect('opossum', opossum)}
            onDisconnect={() => void handleDisconnect('opossum', opossum)}
          />

          <AuxDeviceRow
            title="爪印传感器"
            description="按键 / 姿态传感器，可开启传感器触发功能后驱动 AI 主动响应。"
            connected={pawPrintsState.connected}
            deviceName={pawPrintsState.deviceName}
            battery={pawPrintsState.battery}
            connecting={connectingKind === 'paw-prints'}
            error={errors['paw-prints']}
            onConnect={() => void handleConnect('paw-prints', pawPrints)}
            onDisconnect={() => void handleDisconnect('paw-prints', pawPrints)}
          />

          <AuxDeviceRow
            title="灵猫传感器"
            description="压力传感器，可开启传感器触发功能后驱动 AI 主动响应。"
            connected={civetEdgingState.connected}
            deviceName={civetEdgingState.deviceName}
            battery={civetEdgingState.battery}
            connecting={connectingKind === 'civet-edging'}
            error={errors['civet-edging']}
            onConnect={() => void handleConnect('civet-edging', civetEdging)}
            onDisconnect={() => void handleDisconnect('civet-edging', civetEdging)}
          />
        </div>
      </section>

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
