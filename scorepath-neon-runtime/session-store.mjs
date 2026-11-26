// PostgreSQL-backed express-session Store for ephemeral Render servers.
import pg from 'pg';
export function createNeonSessionStore(session,databaseUrl){
 const pool=new pg.Pool({connectionString:databaseUrl,max:3,connectionTimeoutMillis:10000,query_timeout:15000,statement_timeout:15000});
 class NeonStore extends session.Store{
  get(sid,cb){pool.query('SELECT data FROM scorepath_neon_sessions WHERE sid=$1 AND expires_at>NOW()',[sid]).then(r=>cb(null,r.rows[0]?.data||null)).catch(cb);}
  set(sid,sess,cb){
   const exp=sess?.cookie?.expires?new Date(sess.cookie.expires):new Date(Date.now()+7*24*3600*1000);
   pool.query('INSERT INTO scorepath_neon_sessions(sid,data,expires_at) VALUES($1,$2::jsonb,$3) ON CONFLICT(sid) DO UPDATE SET data=EXCLUDED.data,expires_at=EXCLUDED.expires_at',[sid,JSON.stringify(sess),exp]).then(()=>cb&&cb(null)).catch(e=>cb&&cb(e));
  }
  touch(sid,sess,cb){
   const exp=sess?.cookie?.expires?new Date(sess.cookie.expires):new Date(Date.now()+7*24*3600*1000);
   pool.query('UPDATE scorepath_neon_sessions SET expires_at=$2 WHERE sid=$1',[sid,exp]).then(()=>cb&&cb(null)).catch(e=>cb&&cb(e));
  }
  destroy(sid,cb){pool.query('DELETE FROM scorepath_neon_sessions WHERE sid=$1',[sid]).then(()=>cb&&cb(null)).catch(e=>cb&&cb(e));}
 }
 const store=new NeonStore();
 const cleanup=setInterval(()=>{pool.query('DELETE FROM scorepath_neon_sessions WHERE expires_at<NOW()').catch(e=>console.error('[Neon session cleanup]',e.message));},60*60*1000);cleanup.unref();
 pool.on('error',e=>console.error('[Neon session pool]',e.message));
 return store;
}
