-- Step 10.5: seed a throw-away database for EXPLAIN (ANALYZE) of the hot queries.
-- Usage in docs/performance.md. Never run against a real database.
\timing off
insert into users (id,name,email,"emailVerified","updatedAt") select 'u'||g,'User '||g,'u'||g||'@example.com',true,now() from generate_series(1,20000) g;
insert into projects (id,"ownerId",name,"updatedAt") select 'p'||g,'u'||(1+(g%20000)),'P'||g,now() from generate_series(1,5000) g;
-- 200k workspaces; u1 owns every 500th (400), a quarter in projects
insert into workspaces (id,"ownerId","projectId",title,"lastActivityAt","updatedAt")
 select 'w'||g, case when g%500=0 then 'u1' else 'u'||(2+(g%19999)) end,
        case when g%4=0 then 'p'||(1+(g%5000)) else null end, 'W'||g, now()-(g||' minutes')::interval, now()
 from generate_series(1,200000) g;
insert into workspace_members (id,"workspaceId","userId",role,"invitedById")
 select 'm'||g,'w'||(1+(g*7)%200000), case when g%2000=0 then 'u1' else 'u'||(2+(g%19999)) end,'VIEWER','u2' from generate_series(1,100000) g
 on conflict do nothing;
insert into project_members (id,"projectId","userId",role,"invitedById")
 select 'pm'||g,'p'||(1+(g*3)%5000),'u'||(2+(g%19999)),'VIEWER','u2' from generate_series(1,10000) g on conflict do nothing;
insert into responses (id,workspace_id,created_by_id,prompt,sort_at)
 select 'r'||g, case when g<=300 then 'w500' else 'w'||(1+(g%200000)) end,'u1','P', now()-(g||' seconds')::interval from generate_series(1,500000) g;
insert into response_versions (id,response_id,number,status,content,model_key,provider_model_id,prompt_version,created_by_id)
 select 'v'||g,'r'||g,1,'COMPLETE','x','text-economy','m','1','u1' from generate_series(1,500000) g;
insert into credit_accounts (id,user_id,updated_at) select 'a'||g,'u'||g,now() from generate_series(1,20000) g;
insert into credit_ledger (id,account_id,type,plan_delta,topup_delta,plan_after,topup_after,idempotency_key,created_at)
 select 'l'||g, case when g%300=0 then 'a1' else 'a'||(2+(g%19999)) end,'SETTLE',-1,0,0,0,'k'||g, now()-(g||' seconds')::interval from generate_series(1,1000000) g;
insert into annotations (id,workspace_id,response_id,version_id,created_by_id,kind,anchor_exact,anchor_prefix,anchor_suffix,updated_at)
 select 'an'||g,'w500','r1',case when g<=200 then 'v1' else 'v'||(1+(g%500000)) end,'u1','COMMENT','x','','',now() from generate_series(1,300000) g;
analyze;
-- Spread annotations over many responses (200 stay on r1 / v1).
update annotations set response_id='r'||(1+(substr(id,3)::int % 500000)), workspace_id='w'||(1+(substr(id,3)::int % 200000)) where substr(id,3)::int > 200;
analyze annotations;
