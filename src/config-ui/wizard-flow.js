/** Typed presenter state; adapters own transport, rendering and scheduling. No DOM or commands. */
export function wizardFlow(boot, api, changed) {
  const state = { screen: 'detect', locale: boot.locale, options: { ...boot.wizard.options },
    clients: boot.wizard.clients ?? boot.wizard.detection.filter((c) => c.installed).map((c) => c.client),
    plan: null, consent: false, job: null, events: [], cursor: 0, preview: null, error: '',
    takeover: false, owns: true, active: false, planning: false, unknown: false, followupKind: null, operation: 'install' };
  let revision = 0, initiated = false, following = null, key = null;
  const emit = (focus = false) => changed(state, focus);
  const go = (screen) => { if (screen === 'detect') state.operation = 'install'; state.screen = screen; state.error = ''; state.consent = false; state.preview = null; emit(true); };
  const invalidate = () => { revision++; state.planning = false; state.plan = null; state.preview = null; state.consent = false; emit(); };
  const recorded = (client) => Boolean(boot.wizard.installed?.[client]);
  const allowed = () => state.clients.length > 0 && boot.wizard.requirements.every((r) => r.ok)
    && state.clients.every((client) => boot.wizard.detection.some((row) => row.client === client && row.installed))
    && (state.operation === 'install' || state.clients.every(recorded));
  const fail = (reason) => { state.planning = false; state.error = reason; emit(true); };
  async function review() {
    if (state.planning) return; // the plan is being calculated: asking again must not restart it
    if (!allowed()) return fail(boot.catalogs[state.locale].wizard.missing);
    invalidate(); go('review');
    const version = revision;
    state.planning = true; emit();
    const result = await api('/api/install/plan', 'POST', { operation: state.operation, clients: state.clients, options: state.operation === 'install' ? state.options : {} });
    if (version !== revision) return;
    state.planning = false;
    if (result.status !== 200) return fail(result.value.reason);
    state.plan = result.value; emit();
  }
  async function own() {
    const response = await api('/api/keepalive', 'POST', { instance: boot.instance });
    state.owns = response.status === 200 && response.value.ok === true;
    if (!state.owns) fail(boot.catalogs[state.locale].wizard.locked);
    return state.owns;
  }
  async function apply() {
    if (!state.consent || !state.plan?.plan.reviewable || !allowed() || !await own()) return;
    key ??= `install-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const response = await api('/api/install/apply', 'POST', { planId: state.plan.planId,
      consent: true, idempotencyKey: key });
    if (response.status === 409) { key = null; await review(); return; }
    if (response.status !== 200) return fail(response.value.reason);
    initiated = true; state.job = response.value; state.active = true; go('applying');
  }
  async function poll() {
    const response = await api(`/api/install/job?after=${state.cursor}`, 'GET');
    if (response.status !== 200) throw new Error(boot.catalogs[state.locale].wizard.retry);
    const job = response.value;
    if (!job.jobId) return false;
    if (state.job?.jobId !== job.jobId || job.fullSnapshot) state.events = [];
    state.job = job; state.cursor = job.seq ?? 0;
    const unique = new Map([...state.events, ...job.events].map((event) => [event.seq, event]));
    state.events = [...unique.values()].slice(-128);
    state.active = ['applying', 'waiting'].includes(job.state)
      || job.followups?.some((item) => item.state === 'applying');
    if (!initiated) state.takeover = true;
    if (following && !state.active) {
      following = null; state.preview = null; state.consent = false;
      if (state.screen === 'models') emit();
    }
    if (initiated && state.screen === 'applying' && !state.active) go(state.operation === 'models' ? 'models' : 'result');
    else emit();
    return state.active;
  }
  async function preview(kind, client, data = {}) {
    state.preview = null; state.consent = false; state.followupKind = kind; emit();
    if (!await own()) return;
    const version = revision;
    const response = await api('/api/install/followup-plan', 'POST', { jobId: state.job.jobId, kind, client, ...data });
    if (version !== revision) return;
    if (response.status !== 200) return fail(response.value.reason);
    state.preview = response.value; emit();
  }
  async function followup() {
    if (!state.preview || !state.consent || state.active || !await own()) return;
    const response = await api('/api/install/followup', 'POST', { jobId: state.job.jobId,
      followupId: state.preview.followupId, kind: state.followupKind, consent: true,
      idempotencyKey: state.preview.followupId });
    if (response.status !== 200) { invalidate(); return fail(response.value.reason); }
    following = response.value.followupId; state.active = true; state.consent = false; emit();
  }
  // An installed client offers the three reruns. Each one only starts a review: nothing is written before the consent.
  function rerun(operation) {
    const installed = Object.keys(boot.wizard.installed ?? {});
    if (!['update', 'repair', 'models'].includes(operation) || !installed.length) return;
    state.operation = operation; state.clients = installed;     return review();
  }
  return { state, go, allowed, review, rerun, apply, poll, preview, followup, own, fail,
    change(name, value) { state[name] = value; invalidate(); },
    consent(value) { state.consent = value === true; emit(); },
    take() { initiated = true; state.takeover = false; go(state.active ? 'applying' : 'result'); },
    async answer(answer) {
      const question = state.job?.question;
      if (!question || !await own()) return;
      const response = await api('/api/install/answer', 'POST', { jobId: state.job.jobId,
        questionId: question.questionId, answer });
      if (response.status !== 200 && response.status !== 409) fail(response.value.reason);
      await poll();
    },
    async cancel() { if (await own()) { await api('/api/install/cancel', 'POST', {}); await poll(); } },
  };
}
