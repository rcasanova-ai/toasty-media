<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Access-Control-Allow-Origin: https://toasty.media');
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); echo json_encode(['error'=>'POST required']); exit; }
if (strlen(file_get_contents('php://input')) > 12000) { http_response_code(413); exit; }
$data=json_decode(file_get_contents('php://input'),true);
if (!is_array($data)) { http_response_code(400); echo json_encode(['error'=>'Invalid JSON']); exit; }
$mode=$data['mode']??'lookout';
function fail(string $s,int $code=400):never {http_response_code($code);echo json_encode(['error'=>$s]);exit;}
if (!in_array($mode,['lookout','repository'],true)) fail('Invalid scan mode.');
if (empty($data['authorized'])) fail('Confirm that you own or are authorized to assess this target.');
$ip=$_SERVER['REMOTE_ADDR']??'unknown';
$key=hash('sha256',$ip);
$bucket=sys_get_temp_dir().'/shipwrekt-rate-'.$key;
$now=time();$old=@file_get_contents($bucket);$v=$old?json_decode($old,true):[];
$v=is_array($v)?array_values(array_filter($v,fn($t)=>is_int($t)&&$t>$now-3600)):[];
if(count($v)>=12)fail('Hourly scan limit reached. Please try again later.',429);
$v[]=$now;@file_put_contents($bucket,json_encode($v),LOCK_EX);
function globalIp(string $ip):bool {return filter_var($ip,FILTER_VALIDATE_IP,FILTER_FLAG_NO_PRIV_RANGE|FILTER_FLAG_NO_RES_RANGE)!==false;}
function github(string $url,?string $token=null):array {
  $c=curl_init($url);$headers=['Accept: application/vnd.github+json','User-Agent: SHIPWREKT-Assessment/0.2','X-GitHub-Api-Version: 2022-11-28'];
  if($token)$headers[]='Authorization: Bearer '.$token;
  curl_setopt_array($c,[CURLOPT_RETURNTRANSFER=>true,CURLOPT_HTTPHEADER=>$headers,CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>12,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_MAXREDIRS=>0,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,CURLOPT_MAXFILESIZE=>1500000]);
  $body=curl_exec($c);$status=curl_getinfo($c,CURLINFO_HTTP_CODE);curl_close($c);
  if(!is_string($body))fail('GitHub connection failed.',502);
  if($status===401||$status===403)fail('GitHub denied access. Check the token permissions or API limit.',403);
  if($status===404)fail('Repository not found or token lacks access.',404);
  if($status<200||$status>=300)fail('GitHub API returned HTTP '.$status,502);
  $json=json_decode($body,true);if(!is_array($json))fail('Invalid GitHub response.',502);return $json;
}
$findings=[];
function finding(string $level,string $title,string $evidence,string $fix):void {global $findings;$findings[]=['severity'=>$level,'title'=>$title,'evidence'=>$evidence,'recommendation'=>$fix];}
if($mode==='lookout'){
  $url=trim((string)($data['url']??''));
  $parts=parse_url($url);
  if(!$parts||strtolower($parts['scheme']??'')!=='https'||empty($parts['host'])||isset($parts['user'])||isset($parts['pass'])||isset($parts['port'])||isset($parts['query'])||isset($parts['fragment'])||!in_array($parts['path']??'',['','/'],true))fail('Enter a public HTTPS homepage, for example https://example.com');
  $host=strtolower($parts['host']);
  if(!preg_match('/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/D',$host)||!str_contains($host,'.')||str_ends_with($host,'.local'))fail('Public domain required.');
  $ips=gethostbynamel($host);
  if(!$ips||count(array_filter($ips,'globalIp'))!==count($ips))fail('Only publicly routable targets are permitted.');
  $pinned=$ips[0];
  $ch=curl_init('https://'.$host.'/');
  curl_setopt_array($ch,[CURLOPT_RETURNTRANSFER=>true,CURLOPT_HEADER=>true,CURLOPT_NOBODY=>false,CURLOPT_HTTPGET=>true,CURLOPT_RANGE=>'0-8191',CURLOPT_TIMEOUT=>12,CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,CURLOPT_RESOLVE=>[$host.':443:'.$pinned],CURLOPT_USERAGENT=>'SHIPWREKT-Lookout/0.2 (passive authorized check)',CURLOPT_MAXFILESIZE=>32768]);
  $headers=[];curl_setopt($ch,CURLOPT_HEADERFUNCTION,function($ch,$line)use(&$headers){$p=explode(':',$line,2);if(count($p)===2)$headers[strtolower(trim($p[0]))]=trim($p[1]);return strlen($line);});
  $response=curl_exec($ch);$status=curl_getinfo($ch,CURLINFO_HTTP_CODE);$error=curl_error($ch);$ssl=curl_getinfo($ch,CURLINFO_SSL_VERIFYRESULT);curl_close($ch);
  if($response===false)fail('HTTPS request failed: '.($error?'Connection or certificate error':'Unknown error'),502);
  foreach(['strict-transport-security'=>['medium','HSTS header absent','Enable HSTS after confirming HTTPS on all subdomains.'],'content-security-policy'=>['medium','CSP header absent','Add a tested Content Security Policy.'],'x-content-type-options'=>['low','MIME protection absent','Set X-Content-Type-Options: nosniff.'],'referrer-policy'=>['low','Referrer Policy absent','Set a suitable Referrer-Policy.']] as $h=>$v)if(!isset($headers[$h]))finding($v[0],$v[1],$h.' not present',$v[2]);
  if(isset($headers['x-content-type-options'])&&strtolower($headers['x-content-type-options'])!=='nosniff')finding('low','Invalid MIME protection','X-Content-Type-Options is not nosniff','Set it to nosniff.');
  if($status>=500)finding('medium','Origin returned server error','HTTP '.$status,'Investigate server errors.');
  echo json_encode(['ok'=>true,'product'=>'The Lookout','target'=>'https://'.$host,'checked_at'=>gmdate('c'),'http_status'=>$status,'tls_verified'=>$ssl===0,'checks'=>['HTTPS certificate validation','HTTP status','HSTS','Content Security Policy','MIME protection','Referrer Policy'],'findings'=>$findings,'limitations'=>['Passive homepage request only.','No authenticated, database, exploit, or source-code tests.','Missing headers are configuration signals, not proof of compromise.']]);exit;
}
$repo=trim((string)($data['repository']??''));
if(!preg_match('~^[a-zA-Z0-9_.-]{1,39}/[a-zA-Z0-9_.-]{1,100}$~D',$repo))fail('Enter repository as owner/name.');
$token=trim((string)($data['token']??''));
if($token!==''&&!preg_match('/^(github_pat_|gh[pousr]_)[A-Za-z0-9_]{15,250}$/D',$token))fail('Invalid GitHub token format.');
$root=github('https://api.github.com/repos/'.$repo,$token?:null);
if(($root['private']??false)&&!$token)fail('Private repository requires a fine-grained read-only token.',403);
$branch=$root['default_branch']??'main';
$enc=rawurlencode($branch);
$protection=null;
try{$protection=github('https://api.github.com/repos/'.$repo.'/branches/'.$enc.'/protection',$token?:null);}catch(Throwable $e){}
$prs=github('https://api.github.com/repos/'.$repo.'/pulls?state=closed&per_page=30',$token?:null);
$commits=github('https://api.github.com/repos/'.$repo.'/commits?per_page=30',$token?:null);
$deployments=github('https://api.github.com/repos/'.$repo.'/deployments?per_page=30',$token?:null);
$contributors=github('https://api.github.com/repos/'.$repo.'/contributors?per_page=30',$token?:null);
if($protection===null)finding('medium','Branch protection not verified','No protection evidence returned for '.$branch.'. GitHub permissions may restrict visibility.','Confirm branch protection and mandatory reviews.');
$merged=array_values(array_filter($prs,fn($p)=>!empty($p['merged_at'])));
$unreviewed=0;foreach($merged as $pr){if(($pr['user']['login']??'')===($pr['merged_by']['login']??'')&&isset($pr['merged_by']))$unreviewed++;}
if($unreviewed)finding('medium','Self-merged pull requests observed',$unreviewed.' of '.count($merged).' recent merged PRs show the same author and merger. This does not establish missing reviews.','Confirm independent review rules and exceptions.');
if(count($contributors)===1)finding('medium','Single active contributor observed','Only one contributor returned in the current GitHub API sample.','Verify deployment and recovery ownership; API data is incomplete.');
$dates=[];foreach($commits as $c){$d=$c['commit']['committer']['date']??null;if($d)$dates[]=$d;}
$depDates=[];foreach($deployments as $d){if(!empty($d['created_at']))$depDates[]=$d['created_at'];}
$latencies=[];foreach($depDates as $d){$dt=strtotime($d);$prior=array_filter($dates,fn($c)=>strtotime($c)<=$dt);if($prior)$latencies[]=round(($dt-max(array_map('strtotime',$prior)))/60,1);}
if($latencies&&min($latencies)<5)finding('info','Rapid commit-to-deployment interval observed','Shortest approximate interval in available samples: '.min($latencies).' minutes. Events are not necessarily causally linked.','Check whether automated tests, approvals and rollback gates cover rapid releases.');
echo json_encode(['ok'=>true,'product'=>'The Scanner: GitHub proof of concept','repository'=>$repo,'checked_at'=>gmdate('c'),'private'=>(bool)($root['private']??false),'default_branch'=>$branch,'branch_protection_verified'=>$protection!==null,'recent_commits'=>count($commits),'closed_pull_requests'=>count($prs),'merged_pull_requests'=>count($merged),'deployment_events'=>count($deployments),'contributors_in_sample'=>count($contributors),'approximate_commit_to_deploy_minutes'=>$latencies,'findings'=>$findings,'limitations'=>['Read-only GitHub metadata; no code download or secret scanning.','Token is used for this request only, not saved by this application.','Audit log and collaborator access require organization-specific permissions and are not assessed here.','Commit and deployment event proximity does not establish causation.','No payment or billing is processed. This is a limited proof of concept.']]);
