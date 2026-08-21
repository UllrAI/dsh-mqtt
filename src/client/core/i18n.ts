/**
 * Copy for both UI forms.
 *
 * The DSH panel registers these with `ctx.locale` so the shell's language
 * switch drives them; the standalone page picks a locale from the browser.
 */

export const en = {
  nav: 'MQTT Worker',
  title: 'MQTT Worker',
  subtitle: 'Accept coding tasks over MQTT and manage who may send them.',

  stateStarting: 'Starting',
  stateConnecting: 'Connecting to broker',
  stateReady: 'Ready',
  stateBusy: 'Running a task',
  stateDegraded: 'Needs attention',
  stateOffline: 'Offline',
  stateStopped: 'Stopped',
  stateUnknown: 'Unknown',

  loading: 'Reading worker status…',
  live: 'Live',
  polling: 'Polling',
  unreachable: 'Cannot reach the management API',
  retry: 'Retry',
  tokenPrompt: 'This worker needs a management token',
  tokenHint: 'Stored for this browser session only.',
  tokenPlaceholder: 'managementToken',
  connect: 'Connect',
  connected: 'Connected',

  brokerConnected: 'Broker connected',
  brokerDisconnected: 'Broker disconnected',
  workspacesReady: '{count} workspaces ready',
  taskLoad: '{active} of {capacity} task slots in use',
  refresh: 'Refresh',
  addController: 'Add controller',

  healthTitle: 'Health',
  lastHeartbeat: 'Last heartbeat',
  workerState: 'Worker state',
  capacity: 'Task capacity',
  gatewayVersion: 'Gateway version',

  controllersTitle: 'Controllers',
  controllersEmpty: 'No controllers yet',
  pendingCount: '{count} waiting for approval',
  approve: 'Approve',
  reject: 'Reject',
  revoke: 'Revoke',
  approved: 'Controller approved',
  rejected: 'Request rejected',
  revoked: 'Controller revoked',
  lastUsed: 'Last used',
  neverUsed: 'Never used',
  expires: 'Expires',

  historyTitle: 'Recent tasks',
  historyEmpty: 'No tasks yet',
  statusAccepted: 'Accepted',
  statusActive: 'Running',
  statusCompleted: 'Completed',
  statusFailed: 'Failed',
  statusCancelled: 'Cancelled',

  inviteTitle: 'Add a controller',
  inviteIntro: 'Creates a one-time config that expires in ten minutes. It carries no broker password — the controller still needs its own broker credentials.',
  inviteName: 'Controller name',
  invitePlaceholder: 'e.g. My laptop',
  inviteCreate: 'Create config',
  inviteReady: 'Config ready',
  inviteExpiry: 'Expires at {time}. After copying, approve it here to finish.',
  copy: 'Copy config',
  copied: 'Config copied',
  copyFailed: 'Could not copy — select the text and copy it manually.',
  cancel: 'Cancel',
  close: 'Close',
  done: 'Done',

  language: 'Language',

  connectionTitle: 'Broker and advanced',
  brokerUrl: 'Broker URL',
  namespace: 'Namespace',
  nodeId: 'Node id',
  workspaces: 'Workspaces',
  none: 'None configured',
  controllerAuth: 'Controller approval',
  enabled: 'Required',
  disabled: 'Not required',
  privacyNote: 'Only non-sensitive values are shown. Broker passwords, credentials, and real workspace paths are never returned.',
}

export type Dictionary = typeof en

export const zh: Dictionary = {
  nav: 'MQTT Worker',
  title: 'MQTT Worker',
  subtitle: '通过 MQTT 接收编码任务，并管理谁可以提交。',

  stateStarting: '正在启动',
  stateConnecting: '正在连接 Broker',
  stateReady: '就绪',
  stateBusy: '正在执行任务',
  stateDegraded: '需要处理',
  stateOffline: '离线',
  stateStopped: '已停止',
  stateUnknown: '状态未知',

  loading: '正在读取 Worker 状态…',
  live: '实时',
  polling: '轮询中',
  unreachable: '无法连接管理 API',
  retry: '重试',
  tokenPrompt: '该 Worker 需要管理令牌',
  tokenHint: '仅保存在当前浏览器会话中。',
  tokenPlaceholder: 'managementToken',
  connect: '连接',
  connected: '已连接',

  brokerConnected: 'Broker 已连接',
  brokerDisconnected: 'Broker 未连接',
  workspacesReady: '{count} 个工作区可用',
  taskLoad: '已占用 {active}/{capacity} 个任务槽',
  refresh: '刷新',
  addController: '添加控制端',

  healthTitle: '运行状态',
  lastHeartbeat: '最后心跳',
  workerState: 'Worker 状态',
  capacity: '任务容量',
  gatewayVersion: '网关版本',

  controllersTitle: '控制端',
  controllersEmpty: '还没有控制端',
  pendingCount: '{count} 个等待确认',
  approve: '通过',
  reject: '拒绝',
  revoke: '撤销',
  approved: '已通过该控制端',
  rejected: '已拒绝该请求',
  revoked: '已撤销该控制端',
  lastUsed: '最近使用',
  neverUsed: '尚未使用',
  expires: '失效时间',

  historyTitle: '最近任务',
  historyEmpty: '还没有任务记录',
  statusAccepted: '已接收',
  statusActive: '执行中',
  statusCompleted: '已完成',
  statusFailed: '失败',
  statusCancelled: '已取消',

  inviteTitle: '添加控制端',
  inviteIntro: '生成十分钟内有效的一次性配置。其中不含 Broker 密码，控制端仍需使用自己的 Broker 凭据。',
  inviteName: '控制端名称',
  invitePlaceholder: '例如：我的笔记本',
  inviteCreate: '生成配置',
  inviteReady: '配置已就绪',
  inviteExpiry: '将于 {time} 失效。复制后请回到本页完成授权。',
  copy: '复制配置',
  copied: '配置已复制',
  copyFailed: '复制失败，请手动选中文本复制。',
  cancel: '取消',
  close: '关闭',
  done: '完成',

  language: '语言',

  connectionTitle: 'Broker 与高级设置',
  brokerUrl: 'Broker 地址',
  namespace: '命名空间',
  nodeId: '节点 ID',
  workspaces: '工作区',
  none: '未配置',
  controllerAuth: '控制端授权',
  enabled: '需要',
  disabled: '不需要',
  privacyNote: '此处仅展示非敏感信息，不会返回 Broker 密码、凭据或工作区真实路径。',
}

export type Translate = (key: keyof Dictionary, params?: Record<string, string | number>) => string

/** Shipped dictionaries, named the way DSH's own locale plugin names them. */
export type LocaleId = 'en' | 'zh'

const DICTIONARIES: Record<LocaleId, Dictionary> = { en, zh }

export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template
  return template.replaceAll(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key]
    return value === undefined ? match : String(value)
  })
}

/** Standalone translator; the DSH panel uses `ctx.locale` instead. */
export function createTranslate(locale: LocaleId): Translate {
  const dictionary = DICTIONARIES[locale]
  return (key, params) => interpolate(dictionary[key], params)
}
