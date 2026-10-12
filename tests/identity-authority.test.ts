import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfig } from '../src/config';
import { IdentityAuthStore } from '../src/identity-authority';
import { createRuntime } from '../src/server';

const servers: Array<ReturnType<express.Express['listen']>> = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server)=>new Promise<void>((resolve,reject)=>server.close((error)=>error?reject(error):resolve())))); });
async function listen(app:express.Express) {const server=app.listen(0,'127.0.0.1');servers.push(server);await new Promise<void>((resolve)=>server.once('listening',resolve));return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;}

describe('Identity-owned accounts and sessions', () => {
  it('requires an authority and ignores legacy SQL/Redis configuration in independent mode', () => {
    expect(()=>createConfig({AUTH_DATA_SOURCE:'identity'})).toThrow(/required/);
    const config=createConfig({AUTH_DATA_SOURCE:'identity',AUTH_IDENTITY_API_BASE_URL:'http://identity:8086',AUTH_IDENTITY_API_TOKEN:'internal-test',
      AUTH_ALLOW_MOCK_WECHAT:'true',AUTH_DATABASE_URL:'mysql://broken:broken@127.0.0.1:1/old',AUTH_REDIS_URL:'redis://127.0.0.1:1'});
    expect(config.databaseUrl).toBeUndefined(); expect(config.redis).toBeUndefined();
    expect(()=>createConfig({AUTH_DATA_SOURCE:'identity',AUTH_IDENTITY_API_BASE_URL:'http://identity:8086',AUTH_IDENTITY_API_TOKEN:'internal-test'})).toThrow(/Verified WeChat callbacks/);
  });

  it('keeps provider OAuth URLs while delegating tokens, JWKS, scan state and userinfo', async () => {
    const authority=express(); authority.use(express.json());
    const calls:Array<{path:string;body:unknown;authorization?:string}>=[];
    authority.use((req,res,next)=>{expect(req.header('x-identity-internal-token')).toBe('internal-test');calls.push({path:req.path,body:req.body,authorization:req.header('authorization')});next();});
    authority.get('/internal/wechat-oauth/metadata',(_req,res)=>res.json({issuer:'https://identity.test',keys:[{kid:'canonical',kty:'EC'}]}));
    authority.post('/internal/wechat-oauth/token',(req,res)=>res.json({access_token:'identity-es256',refresh_token:'identity-refresh',scope:req.body.scope??'openid profile'}));
    authority.post('/internal/wechat-oauth/userinfo',(_req,res)=>res.json({sub:'42',name:'Canonical user'}));
    authority.post('/internal/wechat-oauth/revoke',(_req,res)=>res.json({success:true}));
    authority.get('/v1/wechat/qrcode',(_req,res)=>res.json({success:true,token:'scene-authority',qrcode:{ticket:'ticket'}}));
    authority.get('/v1/wechat/refresh',(_req,res)=>res.json({success:true,message:'signup',token:'signup-authority'}));
    const authorityUrl=await listen(authority);
    const config=createConfig({AUTH_DATA_SOURCE:'identity',AUTH_IDENTITY_API_BASE_URL:authorityUrl,AUTH_IDENTITY_API_TOKEN:'internal-test',AUTH_TOKEN_SECRET:'state-only-test',AUTH_ALLOW_MOCK_WECHAT:'true',
      AUTH_DATABASE_URL:'mysql://broken:broken@127.0.0.1:1/old',AUTH_REDIS_URL:'redis://127.0.0.1:1'});
    const runtime=await createRuntime(config); expect(runtime.store).toBeInstanceOf(IdentityAuthStore); const url=await listen(runtime.app);
    const metadata=await fetch(`${url}/.well-known/openid-configuration`).then((res)=>res.json());
    expect(metadata).toMatchObject({issuer:'https://identity.test',id_token_signing_alg_values_supported:['ES256']});
    expect(await fetch(`${url}/.well-known/jwks.json`).then((res)=>res.json())).toEqual({keys:[{kid:'canonical',kty:'EC'}]});
    const result=await fetch(`${url}/oauth/token`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'refresh_token',client_id:'bujiaban-web',refresh_token:'old-token'})});
    expect(await result.json()).toMatchObject({access_token:'identity-es256',refresh_token:'identity-refresh'});
    expect(await fetch(`${url}/userinfo`,{headers:{authorization:'Bearer identity-es256'}}).then((res)=>res.json())).toEqual({sub:'42',name:'Canonical user'});
    expect(await fetch(`${url}/v1/wechat/qrcode`).then((res)=>res.json())).toMatchObject({token:'scene-authority'});
    expect(await fetch(`${url}/v1/wechat/refresh?token=scene-authority`).then((res)=>res.json())).toMatchObject({token:'signup-authority'});
    const revoke=await fetch(`${url}/logout`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({refresh_token:'raw-refresh'})}); expect(revoke.status).toBe(200);
    expect(calls.find((call)=>call.path==='/internal/wechat-oauth/revoke')?.body).toEqual({token:'raw-refresh'});
    expect(calls.find((call)=>call.path==='/internal/wechat-oauth/userinfo')?.authorization).toBe('Bearer identity-es256');
  });

  it('fails closed when the authority is unavailable and protects provider APIs', async () => {
    const config=createConfig({AUTH_DATA_SOURCE:'identity',AUTH_IDENTITY_API_BASE_URL:'http://127.0.0.1:1',AUTH_IDENTITY_API_TOKEN:'internal-test',AUTH_TOKEN_SECRET:'state-test',AUTH_ALLOW_MOCK_WECHAT:'true'});
    const runtime=await createRuntime(config); const url=await listen(runtime.app);
    const response=await fetch(`${url}/oauth/token`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'refresh_token',client_id:'bujiaban-web',refresh_token:'old'})});
    expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'temporarily_unavailable'});
    const internal=await fetch(`${url}/internal/wechat-provider/qrcode`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scene:'scene',lifetimeSeconds:60})});expect(internal.status).toBe(401);
  });
});
