// mock-supabase.js — stands in for supabase-js in the browser tests (served in place of the CDN
// script by harness.js). It is not a test itself.
// An in-memory PostgREST over tables persisted in localStorage ('__mockdb', so a reload keeps them),
// with every write appended to '__writes' so a test can assert that viewing issues none.
(function(){
  const PK = {
    training_sessions: ['id'], training_session_sets: ['session_id','block_idx','item_idx','set_idx'],
    training_workouts_completed: ['date','day_idx'], training_prs: ['exercise_name'], training_profile: ['id'],
    training_plan: ['id'], training_water_log: ['date'], training_weights: ['date'], training_food_log: ['id'],
    training_set_log: ['date','day_idx','ex_idx','set_idx'], training_hiit_log: ['date','day_idx','name'],
  };
  const db = () => JSON.parse(localStorage.getItem('__mockdb') || '{}');
  const put = d => localStorage.setItem('__mockdb', JSON.stringify(d));
  const logWrite = w => { const a = JSON.parse(localStorage.getItem('__writes') || '[]'); a.push(w); localStorage.setItem('__writes', JSON.stringify(a)); };
  const key = (t, r) => (PK[t] || ['id']).map(k => String(r[k])).join('|');
  function builder(table){
    const q = {op: 'select', filters: [], orders: [], range: null, single: null, rows: null, opts: {}, ret: false, patch: null};
    const b = {
      select(){ if(q.op !== 'select') q.ret = true; return b; },
      order(c){ q.orders.push(c); return b; },
      range(a, z){ q.range = [a, z]; return b; },
      eq(c, v){ q.filters.push(r => String(r[c]) === String(v)); return b; },
      in(c, vs){ q.filters.push(r => vs.map(String).includes(String(r[c]))); return b; },
      gte(c, v){ q.filters.push(r => r[c] >= v); return b; },
      maybeSingle(){ q.single = 'maybe'; return b; }, single(){ q.single = 'one'; return b; },
      upsert(rows, opts = {}){ q.op = 'upsert'; q.rows = [].concat(rows); q.opts = opts; return b; },
      insert(rows){ q.op = 'insert'; q.rows = [].concat(rows); return b; },
      update(p){ q.op = 'update'; q.patch = p; return b; },
      delete(){ q.op = 'delete'; return b; },
      then(res, rej){ return new Promise(r => setTimeout(r, 5)).then(run).then(res, rej); },
    };
    function run(){
      if(window.__offline) return {data: null, error: {message: 'offline'}};
      const d = db(); const rows = d[table] ||= [];
      const match = r => q.filters.every(f => f(r));
      if(q.op === 'select'){
        let out = rows.filter(match);
        out.sort((x, y) => { for(const c of q.orders){ if(x[c] < y[c]) return -1; if(x[c] > y[c]) return 1; } return 0; });
        const count = out.length;
        if(q.range) out = out.slice(q.range[0], q.range[1] + 1);
        if(q.single) return {data: out[0] ?? null, error: null};
        return {data: JSON.parse(JSON.stringify(out)), error: null, count};
      }
      logWrite({table, op: q.op, n: q.rows?.length ?? null, patch: q.patch, at: Date.now()});
      if(q.op === 'upsert' || q.op === 'insert'){
        q.rows.forEach(r => {
          const i = rows.findIndex(x => key(table, x) === key(table, r));
          if(i < 0) rows.push({...r}); else if(!q.opts.ignoreDuplicates) rows[i] = {...rows[i], ...r};
        });
        put(d); return {data: q.ret ? q.rows : null, error: null};
      }
      if(q.op === 'update'){
        const hit = rows.filter(match); hit.forEach(r => Object.assign(r, q.patch)); put(d);
        return {data: q.ret ? hit.map(r => ({id: r.id})) : null, error: null};
      }
      if(q.op === 'delete'){
        const gone = rows.filter(match); d[table] = rows.filter(r => !match(r));
        if(table === 'training_sessions'){ const ids = new Set(gone.map(r => r.id)); d.training_session_sets = (d.training_session_sets || []).filter(r => !ids.has(r.session_id)); }
        put(d); return {data: null, error: null};
      }
    }
    return b;
  }
  window.supabase = {createClient: () => ({from: builder, auth: {getSession: async () => ({data: {session: null}})}})};
})();
