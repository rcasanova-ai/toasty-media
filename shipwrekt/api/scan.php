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
function github(string $url,?string $token=null,bool $optional=false):array {
  $c=curl_init($url);$headers=['Accept: application/vnd.github+json','User-Agent: SHIPWREKT-Assessment/0.2','X-GitHub-Api-Version: 2022-11-28'];
  if($token)$headers[]='Authorization: Bearer '.$token;
  curl_setopt_array($c,[CURLOPT_RETURNTRANSFER=>true,CURLOPT_HTTPHEADER=>$headers,CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>12,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_MAXREDIRS=>0,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,CURLOPT_MAXFILESIZE=>1500000]);
  $body=curl_exec($c);$status=curl_getinfo($c,CURLINFO_HTTP_CODE);curl_close($c);
  if(!is_string($body))fail('GitHub connection failed.',502);
  if($status===401||$status===403)fail('GitHub denied access. Check the token permissions or API limit.',403);
  if($status===404&&$optional)return [];if($status===404)fail('Repository not found or token lacks access.',404);
  if($status<200||$status>=300)fail('GitHub API returned HTTP '.$status,502);
  $json=json_decode($body,true);if(!is_array($json))fail('Invalid GitHub response.',502);return $json;
}
$findings=[];
function finding(string $level,string $title,string $evidence,string $fix,string $category='security'):void {global $findings;$findings[]=['category'=>$category,'severity'=>$level,'title'=>$title,'evidence'=>$evidence,'recommendation'=>$fix];}
function publicPath(string $host,string $ip,string $path):array {
 $out='';$c=curl_init('https://'.$host.$path);
 curl_setopt_array($c,[CURLOPT_RETURNTRANSFER=>false,CURLOPT_CONNECTTIMEOUT=>3,CURLOPT_TIMEOUT=>6,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,CURLOPT_RESOLVE=>[$host.':443:'.$ip],CURLOPT_USERAGENT=>'SHIPWREKT-Lookout/0.4']);
 curl_setopt($c,CURLOPT_WRITEFUNCTION,function($c,$chunk)use(&$out){$n=max(0,24576-strlen($out));if($n)$out.=substr($chunk,0,$n);return strlen($chunk);});
 $ok=curl_exec($c);$status=(int)curl_getinfo($c,CURLINFO_HTTP_CODE);curl_close($c);
 return ['status'=>$ok===false?0:$status,'body'=>$out];
}
if($mode==='lookout'){
  $url=trim((string)($data['url']??''));
  $parts=parse_url($url);
  if(!$parts||strtolower($parts['scheme']??'')!=='https'||empty($parts['host'])||isset($parts['user'])||isset($parts['pass'])||isset($parts['port'])||isset($parts['query'])||isset($parts['fragment'])||!preg_match('~^/(?:[a-zA-Z0-9._~-]+/)*$~D',$parts['path']??'/'))fail('Enter a public HTTPS homepage or site section, for example https://example.com/');
  $host=strtolower($parts['host']);
  if(!preg_match('/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/D',$host)||!str_contains($host,'.')||str_ends_with($host,'.local'))fail('Public domain required.');
  $ips=gethostbynamel($host);
  if(!$ips||count(array_filter($ips,'globalIp'))!==count($ips))fail('Only publicly routable targets are permitted.');
  $pinned=$ips[0];
  $targetPath=$parts['path']??'/';
  if($targetPath==='')$targetPath='/';
  $ch=curl_init('https://'.$host.$targetPath);
  curl_setopt_array($ch,[CURLOPT_RETURNTRANSFER=>true,CURLOPT_HEADER=>true,CURLOPT_NOBODY=>false,CURLOPT_HTTPGET=>true,CURLOPT_RANGE=>'0-8191',CURLOPT_TIMEOUT=>12,CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,CURLOPT_RESOLVE=>[$host.':443:'.$pinned],CURLOPT_USERAGENT=>'SHIPWREKT-Lookout/0.3 (passive authorized check)']);
  $bodyCapture='';curl_setopt($ch,CURLOPT_WRITEFUNCTION,function($ch,$chunk)use(&$bodyCapture){$remaining=max(0,32768-strlen($bodyCapture));if($remaining>0)$bodyCapture.=substr($chunk,0,$remaining);return strlen($chunk);});
  $headers=[];curl_setopt($ch,CURLOPT_HEADERFUNCTION,function($ch,$line)use(&$headers){$p=explode(':',$line,2);if(count($p)===2)$headers[strtolower(trim($p[0]))]=trim($p[1]);return strlen($line);});
  $response=curl_exec($ch);$status=curl_getinfo($ch,CURLINFO_HTTP_CODE);$curlCode=curl_errno($ch);$error=curl_error($ch);$ssl=curl_getinfo($ch,CURLINFO_SSL_VERIFYRESULT);curl_close($ch);
  if($response===false){$reason=match($curlCode){6=>'Domain DNS lookup failed.',7=>'Connection refused or unreachable.',28=>'Connection timed out.',35,51,60=>'TLS certificate or handshake failed.',default=>'Connection failed (cURL '.$curlCode.').'};fail($reason.' This is a connection diagnostic, not proof of a website vulnerability.',502);}
  // Interpret only publicly visible homepage content. No authentication attempts.
  $body=$bodyCapture;
  $pageTitle='';$description='';$pageText='';
  if(preg_match('~<title[^>]*>(.*?)</title>~is',$body,$m))$pageTitle=trim(html_entity_decode(strip_tags($m[1]),ENT_QUOTES|ENT_HTML5,'UTF-8'));
  if(preg_match('~<meta\\s+[^>]*name=[\\x22\\x27]description[\\x22\\x27][^>]*content=[\\x22\\x27]([^\\x22\\x27]*)~i',$body,$m))$description=trim(html_entity_decode($m[1],ENT_QUOTES|ENT_HTML5,'UTF-8'));
  $pageText=preg_replace('~<script\\b[^>]*>.*?</script>|<style\\b[^>]*>.*?</style>~is',' ',$body);
  $pageText=strtolower(html_entity_decode(strip_tags($pageText),ENT_QUOTES|ENT_HTML5,'UTF-8') );
  $signals=strtolower($pageTitle.' '.$description.' '.$pageText);
  $industries=[
    'tutoring'=>['tutor','tutoring','private lessons','exam preparation','online learning','student support'],
    'healthcare'=>['clinic','patient','medical practice','healthcare','dentist'],
    'ecommerce'=>['shop now','add to cart','checkout','online store'],
    'recruitment'=>['recruitment','executive search','job seekers','hiring'],
    'finance'=>['financial services','investment adviser','banking','accounting firm'],
    'hospitality'=>['hotel','book a room','restaurant','reservations'],
    'professional services'=>['consulting','professional services','advisory']
  ];
  $industry=null;$best=0;
  foreach($industries as $label=>$words){$score=0;foreach($words as $word){if(str_contains($signals,$word))$score++;}if($score>$best){$best=$score;$industry=$label;}}
  $loginObserved=(bool)preg_match('~(?:href|action)\\s*=\\s*[\\x22\\x27][^\\x22\\x27]*(?:login|log-in|signin|sign-in|account)[^\\x22\\x27]*[\\x22\\x27]|type\\s*=\\s*[\\x22\\x27]password[\\x22\\x27]~i',$body);
  $loginText=(bool)preg_match('~\\b(?:log in|login|sign in|client portal|student portal|member portal)\\b~i',$pageText);
  $loginObserved=$loginObserved||$loginText;
  $industryPhrase=$industry==='tutoring'?'tutoring or education':($industry??'an industry I could not confidently identify');
  $cheeky=$industry==='tutoring'?'Helping students pass their exams? Time to see whether your website passes its own security homework.':($industry==='ecommerce'?'Your customers can add things to their cart. Let us make sure trouble cannot add itself to the checkout.':($industry==='recruitment'?'You find the right people. Let us check whether the wrong people might find their way in.':'Nice-looking ship. Now let us check what is happening below deck.'));
  $personalized=[
    'industry'=>$industry,
    'industry_confidence'=>$best>=2?'moderate':($best===1?'low':'unknown'),
    'page_title'=>substr($pageTitle,0,140),
    'login_visible'=>$loginObserved,
    'cheeky_comment'=>$cheeky,
    'observation'=>($industry?'Your public homepage suggests '.$industryPhrase.' services. ':'Your homepage did not clearly identify the business category. ').($loginObserved?'We also noticed what appears to be a login or account entry point.':'We did not identify a login on this homepage. That does not mean your site has none.'),
    'deeper_assessment'=>$loginObserved?'If customers, students or staff sign in, their accounts and personal information deserve a closer look. This free scan cannot establish whether passwords are stored safely, account permissions work correctly or private records are protected. Our deeper assessment examines those controls with your authorization.':'The free scan only checks the public homepage. A deeper assessment can review authentication, private data handling, access permissions and backend safeguards with your authorization.',
    'upgrade_label'=>'Explore The Scanner ($199) or The Boarding Party ($1,000)',
    'upgrade_url'=>'#packages'
  ];
  // Lightweight public-page discoverability and answer-engine readiness checks.
  $hasDescription=(bool)preg_match('~<meta\\s+[^>]*name\\s*=\\s*["\\x27]description["\\x27]~i',$body);
  $hasCanonical=(bool)preg_match('~<link\\s+[^>]*rel\\s*=\\s*["\\x27]canonical["\\x27]~i',$body);
  $hasViewport=(bool)preg_match('~<meta\\s+[^>]*name\\s*=\\s*["\\x27]viewport["\\x27]~i',$body);
  $hasSchema=(bool)preg_match('~<script\\s+[^>]*type\\s*=\\s*["\\x27]application/ld\\x2bjson["\\x27]~i',$body);
  $hasH1=(bool)preg_match('~<h1(?:\\s|>)~i',$body);
  $hasOg=(bool)preg_match('~<meta\\s+[^>]*property\\s*=\\s*["\\x27]og:title["\\x27]~i',$body);
  if(!$pageTitle)finding('low','Missing homepage title','No HTML title detected in the retrieved homepage.','Write a descriptive, unique page title.','visibility');
  if(!$hasDescription)finding('info','Search description not detected','No meta description detected in the retrieved HTML.','Add a concise description explaining who you serve and what you offer.','visibility');
  if(!$hasCanonical)finding('info','Canonical URL not detected','No canonical link detected in the retrieved HTML.','Add a canonical URL where appropriate to reduce duplicate-page ambiguity.','visibility');
  if(!$hasH1)finding('info','Primary heading not detected','No H1 detected in the retrieved HTML.','Use a clear main heading that explains the page.','visibility');
  if(!$hasSchema)finding('info','Structured data not detected','No JSON-LD script detected in the retrieved HTML.','Consider accurate Organization, LocalBusiness or Service schema where applicable. Never invent claims.','visibility');
  $discoverability=['page_title_present'=>(bool)$pageTitle,'meta_description_present'=>$hasDescription,'canonical_present'=>$hasCanonical,'h1_present'=>$hasH1,'structured_data_jsonld_present'=>$hasSchema,'open_graph_title_present'=>$hasOg,'mobile_viewport_present'=>$hasViewport,'note'=>'Basic HTML signals only. This does not measure AI search rankings or guarantee inclusion in AI answers.'];
  foreach(['strict-transport-security'=>['medium','HSTS header absent','Enable HSTS after confirming HTTPS on all subdomains.'],'content-security-policy'=>['medium','CSP header absent','Add a tested Content Security Policy.'],'x-content-type-options'=>['low','MIME protection absent','Set X-Content-Type-Options: nosniff.'],'referrer-policy'=>['low','Referrer Policy absent','Set a suitable Referrer-Policy.']] as $h=>$v)if(!isset($headers[$h]))finding($v[0],$v[1],$h.' not present',$v[2]);
  if(isset($headers['x-content-type-options'])&&strtolower($headers['x-content-type-options'])!=='nosniff')finding('low','Invalid MIME protection','X-Content-Type-Options is not nosniff','Set it to nosniff.');
  if($status>=500)finding('medium','Origin returned server error','HTTP '.$status,'Investigate server errors.');
  $robots=publicPath($host,$pinned,'/robots.txt');
  $sitemap=publicPath($host,$pinned,'/sitemap.xml');
  $privacy=publicPath($host,$pinned,'/privacy');
  $terms=publicPath($host,$pinned,'/terms');
  if($robots['status']===404)finding('info','robots.txt not found','Standard /robots.txt returned 404.','Publish crawler guidance if needed and advertise your sitemap.','visibility');
  if($sitemap['status']===404)finding('low','sitemap.xml not found at standard location','Standard /sitemap.xml returned 404. Another sitemap may exist.','Publish or advertise a valid sitemap.','visibility');
  $links=[];
  if(preg_match_all('~<a\\b[^>]*href\\s*=\\s*["\\x27]([^"\\x27]+)~i',$body,$matches)){
   foreach($matches[1] as $href){$u=parse_url(html_entity_decode($href,ENT_QUOTES|ENT_HTML5,'UTF-8'));if($u===false)continue;if(!isset($u['host'])||strtolower($u['host'])===$host)$links[]=strtolower($u['path']??'');}
  }
  $privacyLinked=(bool)array_filter($links,fn($x)=>str_contains($x,'privacy')||str_contains($x,'data-protection'));
  $termsLinked=(bool)array_filter($links,fn($x)=>str_contains($x,'terms')||str_contains($x,'conditions'));
  $privacyFound=$privacyLinked||$privacy['status']===200;
  $termsFound=$termsLinked||$terms['status']===200;
  if(!$privacyFound)finding('medium','Privacy policy not discovered','No privacy link on sampled homepage and /privacy did not return 200. Other locations were not checked.','Link a service-specific privacy notice describing real data practices.','trust');
  if(!$termsFound)finding('info','Terms of service not discovered','No terms link on sampled homepage and /terms did not return 200. Other locations were not checked.','Consider terms tailored to the services offered and applicable law.','trust');
  $policyText=strtolower(strip_tags($privacy['body']));
  foreach(['lorem ipsum','[company name]','[your company]','insert company name','template privacy policy'] as $placeholder)if($privacy['status']===200&&str_contains($policyText,$placeholder)){finding('medium','Privacy notice contains template language','Placeholder text found in /privacy.','Review the policy against actual data collection, retention, vendors and contact details.','trust');break;}
  $stock=[];foreach(["in today's fast-paced",'ever-evolving landscape','unlock the power','revolutionize the way','seamless experience','cutting-edge solution','delve into','game-changer'] as $phrase)if(str_contains($pageText,$phrase))$stock[]=$phrase;
  if(count($stock)>=2)finding('info','Generic marketing language detected','Several stock phrases were observed; this is not evidence of AI authorship.','Use specific examples, measurable claims and language grounded in your service.','content');
  // Explainable copy-pattern index. This is NOT an AI authorship probability.
  $copySentences=preg_split('/[.!?]+/',$pageText,-1,PREG_SPLIT_NO_EMPTY);
  $lengths=[];foreach($copySentences as $sentence){$n=str_word_count(trim($sentence));if($n>=4)$lengths[]=$n;}
  $wordCount=str_word_count($pageText);
  $average=count($lengths)?array_sum($lengths)/count($lengths):0;
  $variance=0;foreach($lengths as $n)$variance+=($n-$average)**2;
  $variation=count($lengths)>1&&$average>0?sqrt($variance/count($lengths))/$average:null;
  $tokens=preg_split('/[^a-z]+/',strtolower($pageText),-1,PREG_SPLIT_NO_EMPTY);
  $diversity=count($tokens)>=80?count(array_unique($tokens))/count($tokens):null;
  $index=min(100,count($stock)*18+($variation!==null&&count($lengths)>=5&&$variation<0.30?22:0)+($diversity!==null&&$diversity<0.35?15:0));
  $copyProfile=['label'=>'Formulaic copy-pattern index','score'=>$wordCount<100?null:$index,'scale'=>'0 to 100; higher means more formulaic writing signals, not AI probability','word_count'=>$wordCount,'sentence_count'=>count($lengths),'sentence_length_variation'=>$variation===null?null:round($variation,3),'vocabulary_diversity'=>$diversity===null?null:round($diversity,3),'matched_phrases'=>$stock,'confidence'=>$wordCount<100?'insufficient sample':'heuristic only','disclaimer'=>'Cannot establish AI authorship. Formal, translated, templated and human-written text can score highly. No model-based perplexity is calculated.'];
  if($wordCount>=100&&$index>=35)finding('info','Formulaic writing patterns worth reviewing','Copy-pattern index '.$index.'/100 based on repeated stock phrases, sentence-length regularity and vocabulary diversity. This is not an AI authorship estimate.','Replace boilerplate with customer-specific details, verifiable examples and varied sentence construction.','content');
  $publicSummary=['robots_txt_status'=>$robots['status'],'sitemap_xml_status'=>$sitemap['status'],'sitemap_advertised_in_robots'=>(bool)preg_match('~^\\s*Sitemap:~mi',$robots['body']),'privacy_discovered'=>$privacyFound,'terms_discovered'=>$termsFound,'generic_phrases'=>$stock,'limitations'=>['Only the homepage and four standard same-origin paths were requested.','A missing path does not prove the resource is absent elsewhere.','AI authorship cannot reliably be determined from copy alone.']];
  echo json_encode(['ok'=>true,'product'=>'The Lookout','target'=>'https://'.$host.$targetPath,'checked_at'=>gmdate('c'),'http_status'=>$status,'tls_verified'=>$ssl===0,'personalized'=>$personalized,'discoverability'=>$discoverability,'public_checks'=>$publicSummary,'copy_profile'=>$copyProfile,'checks'=>['HTTPS certificate validation','HTTP status','HSTS','Content Security Policy','MIME protection','Referrer Policy'],'findings'=>$findings,'limitations'=>['Homepage and four same-origin public paths only; no paid external APIs or third-party crawling. Search and answer-engine checks are HTML signals, not ranking measurements.','No authenticated, database, exploit, or source-code tests.','Missing headers are configuration signals, not proof of compromise.']]);exit;
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
$protection=github('https://api.github.com/repos/'.$repo.'/branches/'.$enc.'/protection',$token?:null,true);
$prs=github('https://api.github.com/repos/'.$repo.'/pulls?state=closed&per_page=30',$token?:null);
$commits=github('https://api.github.com/repos/'.$repo.'/commits?per_page=30',$token?:null);
$deployments=github('https://api.github.com/repos/'.$repo.'/deployments?per_page=30',$token?:null);
$contributors=github('https://api.github.com/repos/'.$repo.'/contributors?per_page=30',$token?:null);
if(!$protection)finding('medium','Branch protection not verified','No protection evidence returned for '.$branch.'. GitHub permissions may restrict visibility.','Confirm branch protection and mandatory reviews.');
$merged=array_values(array_filter($prs,fn($p)=>!empty($p['merged_at'])));
$unreviewed=0;foreach($merged as $pr){if(($pr['user']['login']??'')===($pr['merged_by']['login']??'')&&isset($pr['merged_by']))$unreviewed++;}
if($unreviewed)finding('medium','Self-merged pull requests observed',$unreviewed.' of '.count($merged).' recent merged PRs show the same author and merger. This does not establish missing reviews.','Confirm independent review rules and exceptions.');
if(count($contributors)===1)finding('medium','Single active contributor observed','Only one contributor returned in the current GitHub API sample.','Verify deployment and recovery ownership; API data is incomplete.');
$dates=[];foreach($commits as $c){$d=$c['commit']['committer']['date']??null;if($d)$dates[]=$d;}
$depDates=[];foreach($deployments as $d){if(!empty($d['created_at']))$depDates[]=$d['created_at'];}
$latencies=[];foreach($depDates as $d){$dt=strtotime($d);$prior=array_filter($dates,fn($c)=>strtotime($c)<=$dt);if($prior)$latencies[]=round(($dt-max(array_map('strtotime',$prior)))/60,1);}
if($latencies&&min($latencies)<5)finding('info','Rapid commit-to-deployment interval observed','Shortest approximate interval in available samples: '.min($latencies).' minutes. Events are not necessarily causally linked.','Check whether automated tests, approvals and rollback gates cover rapid releases.');
echo json_encode(['ok'=>true,'product'=>'The Scanner: Repository Review','repository'=>$repo,'checked_at'=>gmdate('c'),'private'=>(bool)($root['private']??false),'default_branch'=>$branch,'branch_protection_verified'=>!empty($protection),'recent_commits'=>count($commits),'closed_pull_requests'=>count($prs),'merged_pull_requests'=>count($merged),'deployment_events'=>count($deployments),'contributors_in_sample'=>count($contributors),'approximate_commit_to_deploy_minutes'=>$latencies,'findings'=>$findings,'limitations'=>['Read-only GitHub metadata; no code download or secret scanning.','Token is used for this request only, not saved by this application.','Audit log and collaborator access require organization-specific permissions and are not assessed here.','Commit and deployment event proximity does not establish causation.','No payment or billing is processed. This is a limited read-only assessment.']]);
