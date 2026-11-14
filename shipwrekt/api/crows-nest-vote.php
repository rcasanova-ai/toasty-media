<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
$method=$_SERVER['REQUEST_METHOD']??'GET';
if(!in_array($method,['GET','POST'],true)){header('Allow: GET, POST');http_response_code(405);echo json_encode(['error'=>'Method not allowed']);exit;}
function failVote(int $status,string $message):never{http_response_code($status);echo json_encode(['ok'=>false,'error'=>$message]);exit;}
$path=getenv('SHIPWREKT_VOTES_DB')?:'';
if(!$path||!str_starts_with($path,'/')||preg_match('~/(public_html|htdocs|www|shipwrekt)/~i',$path)||!is_dir(dirname($path)))failVote(503,'Feedback temporarily unavailable');
try{
 $db=new PDO('sqlite:'.$path,null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_TIMEOUT=>5]);
 $db->exec('PRAGMA busy_timeout=5000');
 $db->exec('CREATE TABLE IF NOT EXISTS votes (id INTEGER PRIMARY KEY, vote TEXT NOT NULL CHECK(vote IN (\'yes\',\'no\')), visitor_hash TEXT NOT NULL, created_at INTEGER NOT NULL)');
 $db->exec('CREATE INDEX IF NOT EXISTS idx_votes_visitor_time ON votes(visitor_hash,created_at)');
 if($method==='POST'){
  if((int)($_SERVER['CONTENT_LENGTH']??0)>500)failVote(413,'Request too large');
  $origin=$_SERVER['HTTP_ORIGIN']??'';
  if($origin!=='https://toasty.media')failVote(403,'Origin not allowed');
  $raw=file_get_contents('php://input',false,null,0,501);
  $input=json_decode($raw?:'',true);
  $vote=is_array($input)?($input['vote']??null):null;
  if(!in_array($vote,['yes','no'],true))failVote(400,'Invalid vote');
  $ip=(string)($_SERVER['REMOTE_ADDR']??'');
  $ua=substr((string)($_SERVER['HTTP_USER_AGENT']??''),0,250);
  $salt=getenv('SHIPWREKT_VOTES_SALT')?:'';
  if(strlen($salt)<32)failVote(503,'Feedback temporarily unavailable');
  $visitor=hash_hmac('sha256',$ip.'|'.$ua,$salt);
  $db->exec('BEGIN IMMEDIATE TRANSACTION');
  $check=$db->prepare('SELECT 1 FROM votes WHERE visitor_hash=? AND created_at>? LIMIT 1');
  $check->execute([$visitor,time()-86400]);
  if($check->fetchColumn()){$db->rollBack();failVote(429,'One vote per visitor per day');}
  $insert=$db->prepare('INSERT INTO votes(vote,visitor_hash,created_at) VALUES(?,?,?)');
  $insert->execute([$vote,$visitor,time()]);
  $db->commit();
 }
 $counts=['yes'=>0,'no'=>0];
 foreach($db->query('SELECT vote,COUNT(*) AS total FROM votes GROUP BY vote') as $row){$counts[$row['vote']]=(int)$row['total'];}
 echo json_encode(['ok'=>true,'votes'=>$counts]);
}catch(Throwable $e){if(isset($db)&&$db->inTransaction())$db->rollBack();failVote(503,'Feedback temporarily unavailable');}
