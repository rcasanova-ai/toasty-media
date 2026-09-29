#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const dir=mkdtempSync(join(tmpdir(),"toasty-dough-")); const dbPath=join(dir,"test.sqlite");
function db(action, payload={}){const r=spawnSync("python3",["scripts/toasty-auth-db.py"],{input:JSON.stringify({dbPath,action,...payload}),encoding:"utf8"});if(r.status!==0)throw new Error(r.stderr+"\n"+r.stdout);return JSON.parse(r.stdout);}
try{
  let r=db("dough_get",{subjectType:"user",subjectId:"u1"}); assert.equal(r.account.totalBalance,0);
  r=db("dough_post",{id:"e1",subjectType:"user",subjectId:"u1",bucket:"spend",direction:"credit",amount:25,kind:"funding",referenceId:"fund1"}); assert.equal(r.account.spendBalance,25);
  r=db("dough_post",{id:"e2",subjectType:"user",subjectId:"u1",bucket:"spend",direction:"debit",amount:.03,kind:"x402_purchase",referenceId:"x1"}); assert.equal(r.account.spendBalance,24.97);
  r=db("dough_post",{id:"e3",subjectType:"user",subjectId:"u1",bucket:"spend",direction:"debit",amount:.03,kind:"x402_purchase",referenceId:"x1"}); assert.equal(r.idempotent,true); assert.equal(r.account.spendBalance,24.97);
  r=db("dough_post",{id:"e4",subjectType:"user",subjectId:"u1",bucket:"spend",direction:"debit",amount:100,kind:"overspend",referenceId:"x2"}); assert.equal(r.insufficient,true);
  db("dough_post",{id:"e5",subjectType:"dub",subjectId:"dub1",bucket:"earned",direction:"credit",amount:7.5,kind:"jam_earning",referenceId:"jam1"});
  r=db("dough_transfer_dub_to_user",{id:"e6",dubId:"dub1",userId:"u2"}); assert.equal(r.transferred,7.5);
  r=db("dough_get",{subjectType:"user",subjectId:"u2"}); assert.equal(r.account.earnedBalance,7.5);
  r=db("dough_get",{subjectType:"dub",subjectId:"dub1"}); assert.equal(r.account.earnedBalance,0);

  // Malformed amounts are rejected cleanly (never an uncaught exception the JS side can only see as a 500).
  r=db("dough_post",{id:"e7",subjectType:"user",subjectId:"u1",bucket:"spend",direction:"debit",amount:"not-a-number",kind:"bad",referenceId:"bad1"}); assert.equal(r.error,"invalid_amount");
  r=db("dough_post",{id:"e8",subjectType:"user",subjectId:"u1",bucket:"spend",direction:"debit",amount:NaN,kind:"bad",referenceId:"bad2"}); assert.equal(r.error,"invalid_amount");
  r=db("dough_post",{id:"e9",subjectType:"user",subjectId:"u1",bucket:"spend",direction:"debit",amount:-5,kind:"bad",referenceId:"bad3"}); assert.equal(r.error,"invalid_amount");
  r=db("dough_post",{id:"e10",subjectType:"user",subjectId:"u1",bucket:"spend",direction:"debit",amount:Infinity,kind:"bad",referenceId:"bad4"}); assert.equal(r.error,"invalid_amount");

  console.log("Dough ledger: 13 assertions passed");
} finally { rmSync(dir,{recursive:true,force:true}); }