/* DSH lazy-factory browser bundle. React and DSH services remain externals. */
window.__ModuleLoader__.load({
  id: '@athena/autoresearch-web',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useMemo, useRef, useState } = React;
    const API = '/api/autoresearch';
    const TIERS = ['cheap', 'standard', 'deep'];
    const MODES = ['auto', 'enabled', 'never'];
    const ROLES = [
      ['planner', '规划'], ['research-worker', '检索研究'], ['supervisor', '监督'], ['writer', '写作'],
      ['idea-generator', '选题'], ['experiment-reflexion', '实验复盘'], ['model-scout', '模型选择'], ['evidence-agent', '证据'],
    ];
    const INTENSITIES = {
      economy: { label: '节省', maxRunTokens: 60000, candidateLimit: 1, reflexionRounds: 0 },
      balanced: { label: '均衡', maxRunTokens: 120000, candidateLimit: 3, reflexionRounds: 1 },
      deep: { label: '深入', maxRunTokens: 240000, candidateLimit: 5, reflexionRounds: 2 },
    };
    const OPTION_LABELS = {
      auto: '自动', enabled: '启用', never: '不启用', minimal: '精简', legacy: '兼容',
      cheap: '节省档', standard: '标准档', deep: '深入档', inherit: '沿用默认档', disabled: '关闭',
    };
    const FIELD_LABELS = {
      provider: '提供方', model: '模型名称', defaultTier: '默认模型档位',
      brainstorm: '头脑风暴', deepDive: '深入研究', modelScout: '模型选择', experimentReview: '实验复盘',
      postResultSynthesis: '结果整理', paper: '论文输出', mode: '工作流模式',
      candidateLimit: '候选数量', reflexionRounds: '复盘轮数',
      maxInputTokens: '单次输入上限', maxOutputTokens: '单次输出上限', maxRunTokens: '单次运行预算',
      maxRoleCalls: '角色调用上限', maxRetriesPerCall: '单次重试上限', jsonRepairAttempts: 'JSON 修复次数', maxUpgradesPerTask: '任务升级次数',
    };
    const defaults = () => ({ version: 2, modelRouting: { enabled: false, defaultTier: 'standard', tiers: { cheap: {}, standard: {}, deep: {} }, roles: {} }, workflow: { mode: 'minimal', brainstorm: 'auto', deepDive: 'auto', modelScout: 'auto', experimentReview: 'auto', postResultSynthesis: 'auto', paper: 'auto', paperImprovementRounds: 0, candidateLimit: 3, reflexionRounds: 1 }, budget: { maxInputTokens: 24000, maxOutputTokens: 8000, maxRunTokens: 120000, maxRoleCalls: 120, maxRetriesPerCall: 1, jsonRepairAttempts: 1, maxUpgradesPerTask: 1 } });
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
    const merge = (base, value) => { if (!object(base) || !object(value)) return value === undefined ? base : clone(value); const out = clone(base); for (const [key, item] of Object.entries(value)) out[key] = object(item) ? merge(out[key] || {}, item) : clone(item); return out; };
    const read = (value, path) => path.split('.').reduce((current, key) => current?.[key], value);
    const write = (value, path, next) => { const out = clone(value); const keys = path.split('.'); const last = keys.pop(); let cursor = out; for (const key of keys) { if (!object(cursor[key])) cursor[key] = {}; cursor = cursor[key]; } cursor[last] = next; return out; };
    const diff = (before, after, prefix = '') => [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].flatMap((key) => { const path = prefix ? `${prefix}.${key}` : key; const a = before?.[key]; const b = after?.[key]; if (a === undefined && object(b)) return [{ path, value: b }]; if (object(a) && object(b)) return diff(a, b, path); return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, value: b }]; });
    const intensityFor = (document) => {
      if (!document) return 'balanced';
      const candidateLimit = read(document, 'workflow.candidateLimit');
      const reflexionRounds = read(document, 'workflow.reflexionRounds');
      const maxRunTokens = read(document, 'budget.maxRunTokens');
      const match = Object.entries(INTENSITIES).find(([, preset]) => Number(candidateLimit) === preset.candidateLimit && Number(reflexionRounds) === preset.reflexionRounds && Number(maxRunTokens) === preset.maxRunTokens);
      return match?.[0] || 'custom';
    };
    const statusText = (status, dirty) => {
      if (status === 'ready') return dirty ? '未保存' : '已保存';
      return ({ loading: '加载中', empty: '请选择项目', unavailable: '服务不可用', error: '加载失败' })[status] || status;
    };
    const CSS = `.ar-section{padding:20px 24px;max-width:920px;min-width:0;box-sizing:border-box;overflow-wrap:anywhere;color:var(--dsh-fg,#eee)}.ar-section h2{margin:0 0 4px}.ar-muted{opacity:.7}.ar-alert{padding:10px;border:1px solid #b85a62;border-radius:8px;margin:12px 0}.ar-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.ar-card{padding:14px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:10px;margin-top:12px}.ar-card h3{margin:0 0 9px;font-size:15px}.ar-field{display:grid;gap:4px;min-width:0}.ar-field span{font-size:12px;opacity:.78}.ar-field input,.ar-field select,.ar-table input,.ar-table select{width:100%;box-sizing:border-box;min-width:0;padding:7px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 24%,transparent);background:transparent;color:inherit}.ar-table-wrap{overflow-x:auto}.ar-table{width:100%;border-collapse:collapse}.ar-table th,.ar-table td{text-align:left;padding:7px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent);font-size:13px}.ar-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:16px}.ar-button{border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:7px;padding:8px 11px;background:transparent;color:inherit;cursor:pointer}.ar-button.primary{background:#4f72e8;color:#fff;border-color:#4f72e8}.ar-button:disabled{opacity:.45;cursor:not-allowed}.ar-badge{font-size:12px;padding:3px 7px;border-radius:99px;background:color-mix(in srgb,currentColor 12%,transparent)}.ar-workbench-link{display:inline-block;margin-top:12px;font-weight:600}.ar-advanced{margin-top:16px}.ar-advanced>summary{cursor:pointer;font-weight:600}.ar-diff{max-height:170px;overflow:auto;font:12px ui-monospace,monospace;white-space:pre-wrap}@media(max-width:650px){.ar-grid{grid-template-columns:1fr}}`;
    let styleLoaded = false;
    let csrfToken = '';
    const installStyle = () => { if (styleLoaded) return; styleLoaded = true; const style = document.createElement('style'); style.textContent = `${CSS}.ar-section{color:var(--dsh-fg,#222);background:var(--dsh-bg,#fff)}.ar-section .ar-table thead{display:table-header-group}.ar-section>.ar-actions:first-child{float:right;margin-top:0}.ar-section h2{padding-top:6px;font-size:22px}.ar-section>.ar-muted{clear:both;padding-top:10px;font-size:12px;line-height:1.7}.ar-section .ar-badge{align-self:end;justify-self:end;margin-bottom:8px;background:#edf4ec;color:#537450;font-size:11px}.ar-section .ar-workbench-link{display:inline-flex;align-items:center;padding:9px 13px;background:#eaf2e9;color:#226c56;text-decoration:none;border:1px solid #d6e4d4;border-radius:7px;font-size:12px}.ar-section .ar-workbench-link:hover{background:#dcebd9}.ar-section .ar-button.primary{background:#226c56;border-color:#226c56}`; document.head.appendChild(style); };
    async function request(path, options) { const response = await fetch(`${API}${path}`, { ...options, headers: { accept: 'application/json', ...(options?.body ? { 'content-type': 'application/json' } : {}), ...(csrfToken ? { 'x-autoresearch-csrf': csrfToken } : {}), ...(options?.headers || {}) } }); let body; try { body = await response.json(); } catch { body = {}; } if (!response.ok) { const error = new Error(body?.error?.message || `Request failed (${response.status})`); error.status = response.status; throw error; } return body; }
    function Input({ label, path, value, onChange, type = 'text', disabled = false }) { return h('label', { className: 'ar-field', ...(path ? { 'data-path': path } : {}) }, h('span', null, label), h('input', { type, min: type === 'number' ? 0 : undefined, disabled, value: value ?? '', onChange: (event) => onChange(type === 'number' ? (event.target.value === '' ? undefined : Number(event.target.value)) : event.target.value) })); }
    function Select({ label, value, options, onChange, disabled = false, optionLabels = OPTION_LABELS }) { return h('label', { className: 'ar-field' }, h('span', null, label), h('select', { value: value ?? '', disabled, onChange: (event) => onChange(event.target.value) }, options.map((item) => h('option', { key: item, value: item }, optionLabels[item] || item)))); }
    function Card({ title, children }) { return h('div', { className: 'ar-card' }, h('h3', null, title), children); }
    function AutoResearchSection({ close }) {
      installStyle();
      const [projects, setProjects] = useState([]); const [projectId, setProjectId] = useState(''); const [saved, setSaved] = useState(null); const [draft, setDraft] = useState(null); const [revision, setRevision] = useState(null); const [status, setStatus] = useState('loading'); const [message, setMessage] = useState(''); const [showDiff, setShowDiff] = useState(false); const [saving, setSaving] = useState(false);
      const loadVersion = useRef(0);
      const dirty = useMemo(() => Boolean(saved && draft && JSON.stringify(saved) !== JSON.stringify(draft)), [saved, draft]);
      const setPath = (path, value) => setDraft((current) => write(current, path, value));
      const loadProject = async (id) => { if (saving) return; if (dirty && !window.confirm('放弃尚未保存的 AutoResearch 设置吗？')) return; const version = ++loadVersion.current; setProjectId(id); if (!id) { setRevision(null); setSaved(null); setDraft(null); setStatus('empty'); setMessage(''); return; } setRevision(null); setSaved(null); setDraft(null); setStatus('loading'); setMessage(''); setShowDiff(false); try { const result = await request(`/settings?projectId=${encodeURIComponent(id)}`); if (version !== loadVersion.current) return; const document = merge(defaults(), result.document); setRevision(result.revision); setSaved(clone(document)); setDraft(clone(document)); setStatus('ready'); } catch (error) { if (version !== loadVersion.current) return; setStatus('error'); setMessage(error.message); } };
      useEffect(() => { request('/projects').then((result) => { csrfToken = result.csrfToken || ''; setProjects(result.projects || []); if (result.projects?.[0]) loadProject(result.projects[0].id); else { setStatus(result.serviceAttached === false ? 'unavailable' : 'empty'); setMessage(result.serviceAttached === false ? '核心设置服务尚未接入，页面不会写入文件。' : '没有登记的项目。'); } }).catch((error) => { setStatus('error'); setMessage(error.message); }); }, []);
      const disabled = !draft || status !== 'ready' || saving;
      const applyIntensity = (name) => { const preset = INTENSITIES[name]; if (!preset) return; setDraft((current) => ({ ...current, workflow: { ...current.workflow, candidateLimit: preset.candidateLimit, reflexionRounds: preset.reflexionRounds }, budget: { ...current.budget, maxRunTokens: preset.maxRunTokens } })); };
      const save = async () => { if (!draft || !projectId || !dirty) return; setSaving(true); setMessage(''); try { const validation = await request('/settings/validate', { method: 'POST', body: JSON.stringify({ projectId, candidate: draft }) }); if (validation.valid === false || validation.errors?.length) { setMessage(`校验失败：${validation.errors?.map((item) => item.message || item.path).join('；') || '请检查字段。'}`); return; } const operations = diff(saved, draft).map((item) => ({ op: item.value === undefined ? 'remove' : 'replace', path: item.path, ...(item.value === undefined ? {} : { value: item.value }) })); const result = await request('/settings', { method: 'PATCH', body: JSON.stringify({ projectId, expectedRevision: revision, operations }) }); const next = result.document ? merge(defaults(), result.document) : clone(draft); setRevision(result.revision); setSaved(clone(next)); setDraft(clone(next)); setMessage('设置已保存。'); } catch (error) { setMessage(error.status === 409 ? '设置已被其他进程修改，请重新加载后再保存。' : error.message); } finally { setSaving(false); } };
      const tierCards = TIERS.map((tier) => h(Card, { key: tier, title: OPTION_LABELS[tier] }, h('div', { className: 'ar-grid' }, h(Input, { disabled, label: '提供方', value: read(draft, `modelRouting.tiers.${tier}.provider`), onChange: (value) => setPath(`modelRouting.tiers.${tier}.provider`, value) }), h(Input, { disabled, label: '模型名称', value: read(draft, `modelRouting.tiers.${tier}.model`), onChange: (value) => setPath(`modelRouting.tiers.${tier}.model`, value) }))));
      const roleRows = [h('tr', { key: 'role-header' }, ['角色', '模型档位', '升级到', '输入上限', '输出上限'].map((name) => h('th', { key: name }, name))), ...ROLES.map(([id, label]) => { const role = read(draft, `modelRouting.roles.${id}`) || {}; const tier = h('select', { value: role.tier || '', disabled, onChange: (event) => setPath(`modelRouting.roles.${id}.tier`, event.target.value || undefined) }, [h('option', { key: 'inherit', value: '' }, `沿用默认（${read(draft, 'modelRouting.defaultTier') || 'standard'}）`), ...TIERS.map((name) => h('option', { key: name, value: name }, OPTION_LABELS[name]))]); const escalation = h('select', { value: role.escalateTo || '', disabled, onChange: (event) => setPath(`modelRouting.roles.${id}.escalateTo`, event.target.value || undefined) }, [h('option', { key: 'none', value: '' }, '不升级'), ...TIERS.map((name) => h('option', { key: name, value: name }, OPTION_LABELS[name]))]); const input = h('input', { type: 'number', min: 0, disabled, value: role.maxInputTokens ?? '', placeholder: '沿用', onChange: (event) => setPath(`modelRouting.roles.${id}.maxInputTokens`, event.target.value === '' ? undefined : Number(event.target.value)) }); const output = h('input', { type: 'number', min: 0, disabled, value: role.maxOutputTokens ?? '', placeholder: '沿用', onChange: (event) => setPath(`modelRouting.roles.${id}.maxOutputTokens`, event.target.value === '' ? undefined : Number(event.target.value)) }); return h('tr', { key: id }, h('td', null, label, h('div', { className: 'ar-muted' }, id)), h('td', null, tier), h('td', null, escalation), h('td', null, input), h('td', null, output)); })];
      const routingFields = [h(Select, { key: 'defaultTier', label: '默认模型档位', value: read(draft, 'modelRouting.defaultTier') || 'standard', options: TIERS, disabled, onChange: (value) => setPath('modelRouting.defaultTier', value) })];
      const workflowFields = ['brainstorm', 'deepDive', 'modelScout', 'experimentReview', 'postResultSynthesis', 'paper'].map((name) => h(Select, { key: name, label: FIELD_LABELS[name], value: read(draft, `workflow.${name}`), options: MODES, disabled, onChange: (value) => setPath(`workflow.${name}`, value) }));
      const budgetFields = ['maxInputTokens', 'maxOutputTokens', 'maxRunTokens', 'maxRoleCalls', 'maxRetriesPerCall', 'jsonRepairAttempts', 'maxUpgradesPerTask'].map((name) => h(Input, { key: name, path: `budget.${name}`, disabled, label: FIELD_LABELS[name], type: 'number', value: read(draft, `budget.${name}`), onChange: (value) => setPath(`budget.${name}`, value) }));
      const closeSection = () => { if (dirty && !window.confirm('放弃尚未保存的 AutoResearch 设置吗？')) return; close?.(); };
      const workbenchHref = '/?autoresearch=1';
      const children = [
        h('div', { key: 'reload', className: 'ar-actions' }, h('button', { className: 'ar-button', disabled: !projectId || status === 'loading' || saving, onClick: () => loadProject(projectId) }, '重新加载')),
        h('h2', { key: 'title' }, 'AutoResearch'), h('p', { key: 'intro', className: 'ar-muted' }, '按项目保存研究设置。模型账号仍在 DSH 的 Models 中管理。'),
        h('div', { key: 'project', className: 'ar-grid' }, h(Select, { label: '项目', value: projectId, options: ['', ...projects.map((project) => project.id)], optionLabels: Object.fromEntries([['', '请选择项目'], ...projects.map((project) => [project.id, project.name])]), onChange: loadProject }), h('span', { className: 'ar-badge', 'aria-live': 'polite' }, statusText(status, dirty))),
        h('a', { key: 'workbench', className: 'ar-workbench-link', href: workbenchHref }, '打开科研工作台'),
        message ? h('div', { key: 'message', className: 'ar-alert', role: 'alert' }, message) : null,
        h(Card, { key: 'simple', title: '常用设置' }, h('div', { className: 'ar-grid' }, h(Select, { label: '模型来源', value: read(draft, 'modelRouting.enabled') ? 'custom' : 'inherit', options: ['inherit', 'custom'], optionLabels: { inherit: '沿用 DSH', custom: '使用本页设置' }, disabled, onChange: (value) => setPath('modelRouting.enabled', value === 'custom') }), h(Select, { label: '研究强度', value: intensityFor(draft), options: ['economy', 'balanced', 'deep', 'custom'], optionLabels: { economy: '节省', balanced: '均衡', deep: '深入', custom: '自定义' }, disabled, onChange: (value) => applyIntensity(value) }), h(Select, { label: '论文输出', value: read(draft, 'workflow.paper') || 'auto', options: ['auto', 'enabled', 'never'], optionLabels: { auto: '自动', enabled: '生成', never: '不生成' }, disabled, onChange: (value) => setPath('workflow.paper', value) }))),
        h('details', { key: 'advanced', className: 'ar-advanced' }, h('summary', null, '高级设置'), h(Card, { title: '模型档位' }, h('p', { className: 'ar-muted' }, '自定义模型仅保存引用；密钥继续由 DSH 管理。'), h('div', { className: 'ar-grid' }, ...routingFields), h('div', { className: 'ar-grid' }, tierCards)), h(Card, { title: '角色路由' }, h('div', { className: 'ar-table-wrap' }, h('table', { className: 'ar-table' }, h('thead', null, h('tr', null, ['角色', '模型档位', '升级到', '输入上限', '输出上限'].map((name) => h('th', { key: name }, name)))), h('tbody', null, roleRows)))), h(Card, { title: '工作流' }, h('div', { className: 'ar-grid' }, h(Select, { label: FIELD_LABELS.mode, value: read(draft, 'workflow.mode'), options: ['minimal', 'legacy'], disabled, onChange: (value) => setPath('workflow.mode', value) }), ...workflowFields), h('div', { className: 'ar-grid' }, h(Input, { path: 'workflow.candidateLimit', disabled, label: FIELD_LABELS.candidateLimit, type: 'number', value: read(draft, 'workflow.candidateLimit'), onChange: (value) => setPath('workflow.candidateLimit', value) }), h(Input, { path: 'workflow.reflexionRounds', disabled, label: FIELD_LABELS.reflexionRounds, type: 'number', value: read(draft, 'workflow.reflexionRounds'), onChange: (value) => setPath('workflow.reflexionRounds', value) }))), h(Card, { title: '预算' }, h('div', { className: 'ar-grid' }, budgetFields))),
        showDiff ? h(Card, { key: 'diff', title: '保存差异' }, h('div', { className: 'ar-diff' }, diff(saved || {}, draft || {}).map((item) => `${item.path} = ${JSON.stringify(item.value)}`).join('\n') || '没有变化')) : null,
        h('div', { key: 'actions', className: 'ar-actions' }, h('button', { className: 'ar-button', disabled: !dirty || saving, onClick: () => { setDraft(clone(saved)); setMessage('已撤销草稿修改。'); } }, '撤销'), h('button', { className: 'ar-button', disabled: disabled || !dirty, onClick: () => setShowDiff((value) => !value) }, showDiff ? '隐藏差异' : '预览差异'), h('button', { className: 'ar-button primary', disabled: disabled || !dirty || saving, onClick: save }, saving ? '保存中…' : '校验并保存'), h('button', { className: 'ar-button', onClick: closeSection }, '关闭')),
      ];
      return h('section', { className: 'ar-section', 'aria-label': 'AutoResearch project settings' }, children);
    }
    function WorkbenchBrandName() {
      return h('a', { href: '/?autoresearch=1', className: 'ar-native-brand', 'aria-label': '打开科研工作台', style: { display: 'inline-flex', alignItems: 'center', gap: '6px', color: 'inherit', textDecoration: 'none', whiteSpace: 'nowrap' } }, '科研工作台');
    }
    function apply(ctx) {
      ctx.locale.register('autoresearch', { en: { 'autoresearch.nav': 'AutoResearch' }, zh: { 'autoresearch.nav': 'AutoResearch' } });
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'autoresearch', order: 30, label: () => 'AutoResearch', locale: 'autoresearch' }, AutoResearchSection));
      // A lower priority intentionally shadows the official single brand-name seat while
      // leaving its independent brand mark and the rest of the sidebar intact.
      ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name', id: 'autoresearch-workbench', priority: -100, locale: 'autoresearch' }, WorkbenchBrandName));
      if (typeof installNativeWorkbench === 'function') installNativeWorkbench(ctx, React);
    }
    module.exports = { inject: ['locale', 'slots'], apply, AutoResearchSection, WorkbenchBrandName };
    return module.exports;
  }
});
