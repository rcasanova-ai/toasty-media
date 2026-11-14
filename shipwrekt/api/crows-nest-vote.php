<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
$method=$_SERVER['REQUEST_METHOD']??'GET';
if(!in_array($method,['GET','POST'],true)){http_response_code(405);echo json_encode(['error'=>'Method not allowed']);exit;}
$dir=sys_get_temp_dir().'/shipwrekt-interest';
if(!is_dir($dir)&&!@mkdir($dir,0700,true)&&!is_dir($dir)){http_response_code(503);echo json_encode(['error'=>'Feedback unavailable']);exit;}
$file=$dir.'/votes.json';
$handle=@fopen($file,'c+');
if(!$handle||!flock($handle,LOCK_EX)){http_response_code(503);echo json_encode(['error'=>'Feedback unavailable']);exit;}
rewind($handle);$data=json_decode(stream_get_contents($handle),true);
if(!is_array($data))$data=['yes'=>0,'no'=>0];
$data['yes']=max(0,(int)($data['yes']??0));$data['no']=max(0,(int)($data['no']??0));
if($method==='POST'){
  if((int)($_SERVER['CONTENT_LENGTH']??0)>500){http_response_code(413);echo json_encode(['error'=>'Request too large']);exit;}
  $origin=$_SERVER['HTTP_ORIGIN']??'';
  if($origin!==''&&$origin!=='https://toasty.media'){http_response_code(403);echo json_encode(['error'=>'Origin not allowed']);exit;}
  $input=json_decode(file_get_contents('php://input'),true);
  $vote=$input['vote']??null;
  if(!in_array($vote,['yes','no'],true)){http_response_code(400);echo json_encode(['error'=>'Invalid vote']);exit;}
  // A lightweight abuse barrier; IP hashes are not retained. Counts are anonymous aggregates.
  $ip=$_SERVER['REMOTE_ADDR']??'';
  $fingerprint=hash('sha256',$ip.'|'.($_SERVER['HTTP_USER_AGENT']??''));
  $rateFile=$dir.'/rate-'.substr($fingerprint,0,24);
  $last=(int)@file_get_contents($rateFile);
  if($last>time()-86400){http_response_code(429);echo json_encode(['error'=>'One vote per visitor per day']);exit;}
  $data[$vote]++;
  rewind($handle);ftruncate($handle,0);fwrite($handle,json_encode($data));fflush($handle);
  @file_put_contents($rateFile,(string)time(),LOCK_EX);
}
flock($handle,LOCK_UN);fclose($handle);
echo json_encode(['ok'=>true,'votes'=>['yes'=>$data['yes'],'no'=>$data['no']]]);
