import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronRight,
  CircleAlert,
  Clipboard,
  Clock3,
  Database,
  Laptop,
  Monitor,
  MoreHorizontal,
  Radio,
  RefreshCw,
  Settings,
  ShieldCheck,
  UserRoundPlus,
  X,
} from 'lucide-react';

const API_BASE = import.meta.env.VITE_DSH_MQTT_API_URL ?? '/api';
const TOKEN_STORAGE_KEY = 'dsh-mqtt-management-token';

class ManagementApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function apiToken() {
  return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

async function api(path, options = {}) {
  const token = apiToken();
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new ManagementApiError(value.error ?? `管理 API 返回 ${response.status}`, response.status);
  return value;
}

function Modal({ title, children, onClose }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2 id="modal-title">{title}</h2>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={20} /></button>
        </div>
        {children}
      </section>
    </div>
  );
}

function formatTime(value) {
  if (!value) return '尚未使用';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

const stateLabels = {
  'auth-required': '等待访问令牌',
  starting: '正在启动',
  connecting: '正在连接 Broker',
  ready: '可以使用',
  busy: '正在执行任务',
  degraded: '需要处理',
  offline: '离线',
  stopped: '已停止',
};

export function App() {
  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);
  const [controllers, setControllers] = useState([]);
  const [activeMenu, setActiveMenu] = useState(null);
  const [selectedController, setSelectedController] = useState(null);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [invite, setInvite] = useState(null);

  const notify = (message) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2600);
  };

  const reportError = useCallback((reason) => {
    if (reason instanceof ManagementApiError && reason.status === 401) {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      setAuthRequired(true);
      setError('');
      return;
    }
    setError(reason instanceof Error ? reason.message : String(reason));
  }, []);

  const loadData = useCallback(async ({ showHealth = false } = {}) => {
    setError('');
    const [nextStatus, nextConfig, nextControllers] = await Promise.all([
      api('/status'),
      api('/config'),
      api('/controllers'),
    ]);
    setStatus(nextStatus);
    setConfig(nextConfig);
    setControllers(nextControllers.controllers ?? []);
    setAuthRequired(false);
    if (showHealth) setModal('health');
  }, []);

  useEffect(() => {
    let active = true;
    loadData().catch((reason) => {
      if (active) reportError(reason);
    }).finally(() => {
      if (active) setLoading(false);
    });
    const timer = window.setInterval(() => {
      loadData().catch(reportError);
    }, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [loadData, reportError]);

  const authenticateManagement = async (event) => {
    event.preventDefault();
    const token = tokenInput.trim();
    if (!token) return;
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    try {
      await loadData();
      setTokenInput('');
      notify('已连接管理服务');
    } catch (reason) {
      reportError(reason);
    }
  };

  const authorizedControllers = useMemo(() => controllers.filter((controller) => controller.status === 'authorized'), [controllers]);
  const pendingControllers = useMemo(() => controllers.filter((controller) => controller.status === 'pending'), [controllers]);

  const checkStatus = async () => {
    setIsRefreshing(true);
    try {
      await loadData({ showHealth: true });
      notify('状态已从 Worker 更新');
    } catch (reason) {
      reportError(reason);
    } finally {
      setIsRefreshing(false);
    }
  };

  const createInvite = async () => {
    const name = inviteName.trim();
    if (!name) return;
    const value = await api('/controllers/invites', {
      method: 'POST',
      body: JSON.stringify({ name, scopes: ['submit', 'control'], ttl_seconds: 600 }),
    });
    setInvite(value.invite);
    await loadData();
  };

  const invitePayload = invite && config ? JSON.stringify({
    version: 1,
    broker_url: config.url,
    namespace: config.namespace,
    node_id: config.node_id,
    controller_id: invite.id,
    token: invite.token,
    expires_at: new Date(invite.expiresAt).toISOString(),
  }, null, 2) : '';

  const copyInvite = async () => {
    await navigator.clipboard.writeText(invitePayload);
    notify('控制端配置已复制');
  };

  const authorizeController = async (controller) => {
    await api(`/controllers/${encodeURIComponent(controller.id)}/authorize`, { method: 'POST', body: '{}' });
    setModal(null);
    await loadData();
    notify('控制端已授权');
  };

  const revokeController = async (controller) => {
    await api(`/controllers/${encodeURIComponent(controller.id)}`, { method: 'DELETE' });
    setActiveMenu(null);
    setModal(null);
    await loadData();
    notify(controller.status === 'pending' ? '已拒绝控制端请求' : '控制端已撤销');
  };

  const openInvite = () => {
    setInviteName('');
    setInvite(null);
    setModal('invite');
  };

  const openController = (kind, controller) => {
    setSelectedController(controller);
    setModal(kind);
    setActiveMenu(null);
  };

  const workspaceReady = status?.workspaces?.filter((workspace) => workspace.status === 'ready').length ?? 0;
  const state = authRequired ? 'auth-required' : status?.state ?? 'offline';
  const stateClass = state === 'ready' || state === 'busy' ? 'ready-state' : 'warning-state';

  return (
    <main className="shell" onClick={() => setActiveMenu(null)}>
      <header className="topbar">
        <div className="brand">设置</div>
        <button className="config-link" type="button" disabled={!config} onClick={() => setModal('advanced')}>查看连接配置</button>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置导航">
          <span className="nav-item" aria-disabled="true"><Settings size={22} />通用设置</span>
          <span className="nav-item" aria-disabled="true"><Database size={22} />模型</span>
          <span className="nav-item selected" aria-current="page"><Radio size={22} />远程 Worker</span>
        </nav>

        <section className="content" id="remote-worker">
          <div className="page-heading"><h1>远程 Worker</h1></div>

          {loading && <div className="connection-banner"><RefreshCw className="spin" size={18} />正在读取 Worker 状态…</div>}
          {authRequired && <form className="connection-banner auth-banner" onSubmit={authenticateManagement}><ShieldCheck size={18} /><span><strong>需要管理访问令牌</strong>令牌只保存在当前浏览器会话中</span><input type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="输入 managementToken" autoComplete="current-password" autoFocus /><button type="submit" disabled={!tokenInput.trim()}>连接</button></form>}
          {error && <div className="connection-banner error-banner"><CircleAlert size={18} /><span><strong>无法连接管理 API</strong>{error}</span><button type="button" onClick={() => loadData().catch(reportError)}>重试</button></div>}

          <section className="worker-identity" aria-labelledby="worker-name">
            <div className="worker-icon"><Monitor aria-hidden="true" size={31} strokeWidth={1.6} /></div>
            <div className="worker-copy">
              <h2 id="worker-name">{status?.display_name ?? config?.display_name ?? (authRequired ? '等待连接 Worker' : 'Worker 状态不可用')}</h2>
              <p className={stateClass}>{state === 'ready' || state === 'busy' ? <Check size={17} strokeWidth={2.5} /> : <CircleAlert size={17} />}{stateLabels[state] ?? state}</p>
              <p className="worker-subtitle">{status ? `Broker ${status.online ? '已连接' : '未连接'} · ${workspaceReady} 个工作区可用 · ${status.active_requests}/${status.request_capacity} 个任务` : authRequired ? '输入管理访问令牌后读取实时状态' : '等待真实状态数据'}</p>
            </div>
            <div className="worker-actions">
              <button className="primary-button" type="button" onClick={openInvite} disabled={!status}><UserRoundPlus size={18} />添加控制端</button>
              <button className="secondary-button" type="button" onClick={checkStatus} disabled={!status || isRefreshing}><RefreshCw className={isRefreshing ? 'spin' : ''} size={17} />检查状态</button>
            </div>
          </section>

          <section className="section" aria-labelledby="controllers-heading">
            <div className="section-heading-row"><h2 className="section-title" id="controllers-heading">已授权的控制端</h2><span className="controller-count">{authorizedControllers.length} 个</span></div>
            <div className="list-surface controller-list">
              {authorizedControllers.length === 0 ? (
                <div className="empty-row"><ShieldCheck size={21} />还没有已授权的控制端</div>
              ) : authorizedControllers.map((controller) => (
                <div className="list-row controller-row" key={controller.id}>
                  <span className="controller-icon"><Laptop size={20} /></span>
                  <span className="controller-copy"><strong>{controller.name}</strong><span>{controller.scopes.join('、')}</span></span>
                  <span className="last-used">{formatTime(controller.lastUsedAt)}</span>
                  <span className="menu-wrap" onClick={(event) => event.stopPropagation()}>
                    <button className="icon-button menu-button" type="button" aria-label={`管理 ${controller.name}`} onClick={() => setActiveMenu(activeMenu === controller.id ? null : controller.id)}><MoreHorizontal size={21} /></button>
                    {activeMenu === controller.id && <div className="context-menu" role="menu"><button type="button" role="menuitem" onClick={() => openController('permissions', controller)}>查看权限</button><button type="button" role="menuitem" className="danger-item" onClick={() => revokeController(controller).catch(reportError)}>撤销控制端</button></div>}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {pendingControllers.length > 0 && <button className="pending-request" type="button" onClick={() => openController('pending', pendingControllers[0])}><span className="pending-icon"><UserRoundPlus size={20} /></span><span>有 {pendingControllers.length} 个控制端等待确认</span><span className="pending-action">查看请求 <ChevronRight size={18} /></span></button>}

          <button className="advanced-link" type="button" disabled={!config} onClick={() => setModal('advanced')}><Settings size={19} />Broker 与高级设置 <ChevronRight size={18} /></button>
        </section>
      </div>

      {toast && <div className="toast" role="status"><Check size={17} />{toast}</div>}

      {modal === 'invite' && <Modal title="添加控制端" onClose={() => setModal(null)}>
        <p className="modal-intro">生成十分钟有效的一次性配置。它不包含 Broker 密码，控制端仍需使用自己的 Broker 凭据。</p>
        {!invite ? <label className="field-label">控制端名称<input value={inviteName} onChange={(event) => setInviteName(event.target.value)} placeholder="例如：我的 MacBook" autoFocus /></label> : <><div className="invite-code"><span>控制端配置已准备好</span><strong>{invite.name}</strong><code>{invite.id}</code></div><div className="modal-note"><Clock3 size={18} />邀请将在 {new Date(invite.expiresAt).toLocaleTimeString('zh-CN')} 失效，复制后还需要在本页确认授权。</div></>}
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button>{invite ? <button className="primary-button" type="button" onClick={() => copyInvite().catch(reportError)}><Clipboard size={17} />复制配置</button> : <button className="primary-button" type="button" disabled={!inviteName.trim()} onClick={() => createInvite().catch(reportError)}>生成配置</button>}</div>
      </Modal>}

      {modal === 'pending' && selectedController && <Modal title="待确认的控制端" onClose={() => setModal(null)}><div className="request-person"><span className="controller-icon"><Laptop size={20} /></span><span><strong>{selectedController.name}</strong><small>请求权限：{selectedController.scopes.join('、')}</small></span></div><div className="modal-note"><Clock3 size={18} />请求将在 {new Date(selectedController.expiresAt).toLocaleTimeString('zh-CN')} 失效。</div><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => revokeController(selectedController).catch(reportError)}>拒绝</button><button className="primary-button" type="button" onClick={() => authorizeController(selectedController).catch(reportError)}>确认授权</button></div></Modal>}

      {modal === 'health' && status && <Modal title="运行状态详情" onClose={() => setModal(null)}><div className="detail-list"><div><span>最后心跳</span><strong>{formatTime(status.heartbeat_at)}</strong></div><div><span>Worker 状态</span><strong>{stateLabels[status.state] ?? status.state}</strong></div><div><span>任务容量</span><strong>{status.active_requests} / {status.request_capacity}</strong></div>{status.health.map((item) => <div key={item.name}><span>{item.name}</span><strong className={item.status === 'ready' ? 'detail-ready' : 'detail-warning'}>{item.status}{item.message ? ` · ${item.message}` : ''}</strong></div>)}</div><div className="modal-note"><CircleAlert size={18} />状态来自 Gateway 的实时连接、模型和工作区检查，不根据 retained online 字段单独判断。</div></Modal>}

      {modal === 'permissions' && selectedController && <Modal title="控制端权限" onClose={() => setModal(null)}><div className="detail-list"><div><span>控制端</span><strong>{selectedController.name}</strong></div><div><span>允许操作</span><strong>{selectedController.scopes.join('、')}</strong></div><div><span>最近使用</span><strong>{formatTime(selectedController.lastUsedAt)}</strong></div><div><span>授权到期</span><strong>{formatTime(selectedController.expiresAt)}</strong></div></div><div className="modal-actions"><button className="primary-button" type="button" onClick={() => setModal(null)}>完成</button></div></Modal>}

      {modal === 'advanced' && <Modal title="Broker 与高级设置" onClose={() => setModal(null)}><div className="detail-list"><div><span>Broker 地址</span><strong>{config?.url ?? '不可用'}</strong></div><div><span>命名空间</span><strong>{config?.namespace ?? '不可用'}</strong></div><div><span>节点 ID</span><strong>{config?.node_id ?? '不可用'}</strong></div><div><span>工作区</span><strong>{config?.workspaces?.join('、') || '未配置'}</strong></div><div><span>控制端鉴权</span><strong>{config?.controller_auth_required ? '已启用' : '未启用'}</strong></div></div><div className="modal-note"><CircleAlert size={18} />页面只显示非敏感摘要，不返回 Broker 密码、凭据或工作区真实路径。</div></Modal>}
    </main>
  );
}
