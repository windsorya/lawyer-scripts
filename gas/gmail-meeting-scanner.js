/**
 * Gmail 開會通知 → 〈1〉開庭日曆 自動登記腳本（含 OCR）
 * v1.2
 * 每 10 分鐘掃描 Gmail 開會通知，自動建立行事曆事件
 * 
 * 部署前請替換 CONFIG 中的 YOUR_XXX 佔位符
 */

const CONFIG = {
  COURT_CALENDAR_ID: 'YOUR_COURT_CALENDAR_ID',
  PROCESSED_LABEL: '已登記開庭日曆',
  EVENT_PREFIX: '❓ ',
  DEFAULT_DURATION_MINUTES: 120,
  MAX_EMAILS_PER_RUN: 20,
  SEARCH_DAYS_BACK: 30,
  SEARCH_SUBJECT_QUERY: '(subject:(開會通知 OR 會議通知 OR 董事會 OR 審計委員會 OR 股東會 OR 理監事 OR 會員大會 OR 評議委員會 OR 議事手冊) OR (subject:(開會 OR 會議 OR 召開) subject:(通知 OR 邀請)))',
  ENABLE_OCR: true,
  OCR_MIME_TYPES: ['image/png','image/jpeg','image/jpg','image/gif','image/bmp','image/tiff','application/pdf'],
  OCR_MAX_SIZE_BYTES: 10 * 1024 * 1024,
};

function setup() {
  getOrCreateLabel_(CONFIG.PROCESSED_LABEL);
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) { if (t.getHandlerFunction()==='scanMeetingEmails') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('scanMeetingEmails').timeBased().everyMinutes(10).create();
  Logger.log('✅ 設定完成');
  scanMeetingEmails();
}

function scanMeetingEmails() {
  var processedLabel = getOrCreateLabel_(CONFIG.PROCESSED_LABEL);
  var cutoffDate = new Date(); cutoffDate.setDate(cutoffDate.getDate() - CONFIG.SEARCH_DAYS_BACK);
  var dateStr = Utilities.formatDate(cutoffDate, 'Asia/Taipei', 'yyyy/MM/dd');
  var searchQuery = ['after:'+dateStr, '-label:'+CONFIG.PROCESSED_LABEL.replace(/\s/g,'-'), CONFIG.SEARCH_SUBJECT_QUERY].join(' ');
  var threads = GmailApp.search(searchQuery, 0, CONFIG.MAX_EMAILS_PER_RUN);
  var threadData = [];
  for (var i=0;i<threads.length;i++) {
    var msg=threads[i].getMessages()[0];
    threadData.push({thread:threads[i],msg:msg,hasAttachment:msg.getAttachments().length>0});
  }
  threadData.sort(function(a,b){if(a.hasAttachment&&!b.hasAttachment)return-1;if(!a.hasAttachment&&b.hasAttachment)return 1;return 0;});
  var createdCount=0,skippedCount=0;
  for(var i=0;i<threadData.length;i++){
    var thread=threadData[i].thread,msg=threadData[i].msg;
    var subject=msg.getSubject(),body=msg.getPlainBody(),from=msg.getFrom();
    var classification=classifyEmail_(subject,body,from);
    if(!classification.isMeeting){thread.addLabel(processedLabel);skippedCount++;continue;}
    var ocrText='';
    if(CONFIG.ENABLE_OCR){ocrText=ocrAttachments_(msg);}
    var eventInfo=parseEventInfo_(subject,body,msg.getDate(),ocrText);
    if(!eventInfo.startTime){thread.addLabel(processedLabel);skippedCount++;continue;}
    if(isDuplicate_(eventInfo)){thread.addLabel(processedLabel);skippedCount++;continue;}
    var event=createCalendarEvent_(eventInfo,msg);
    if(event)createdCount++;
    thread.addLabel(processedLabel);
  }
  Logger.log('✅ 新建:'+createdCount+' 跳過:'+skippedCount);
}

function ocrAttachments_(msg) {
  var attachments=msg.getAttachments();if(!attachments||attachments.length===0)return'';
  var allText='';
  for(var i=0;i<attachments.length;i++){
    var att=attachments[i],mimeType=att.getContentType().toLowerCase(),size=att.getSize();
    var isSupported=false;
    for(var j=0;j<CONFIG.OCR_MIME_TYPES.length;j++){if(mimeType.includes(CONFIG.OCR_MIME_TYPES[j].split('/')[1])){isSupported=true;break;}}
    if(!isSupported||size>CONFIG.OCR_MAX_SIZE_BYTES)continue;
    try{
      var text=mimeType.includes('pdf')?ocrPdfViaGoogleDrive_(att.copyBlob()):callCloudVisionOCR_(att.copyBlob(),mimeType);
      if(text)allText+='\n'+text;
    }catch(e){Logger.log('OCR失敗：'+e.message);}
  }
  return allText.trim();
}

function callCloudVisionOCR_(blob,mimeType) {
  var base64Data=Utilities.base64Encode(blob.getBytes()),token=ScriptApp.getOAuthToken();
  var response=UrlFetchApp.fetch('https://vision.googleapis.com/v1/images:annotate',{
    method:'post',contentType:'application/json',headers:{'Authorization':'Bearer '+token},
    payload:JSON.stringify({requests:[{image:{content:base64Data},features:[{type:'TEXT_DETECTION',maxResults:1}],imageContext:{languageHints:['zh-TW','zh','en']}}]}),
    muteHttpExceptions:true});
  if(response.getResponseCode()!==200)throw new Error('Cloud Vision API error '+response.getResponseCode());
  var result=JSON.parse(response.getContentText());
  return(result.responses&&result.responses[0]&&result.responses[0].fullTextAnnotation)?result.responses[0].fullTextAnnotation.text:'';
}

function ocrPdfViaGoogleDrive_(blob) {
  try{
    var base64Data=Utilities.base64Encode(blob.getBytes()),token=ScriptApp.getOAuthToken();
    var response=UrlFetchApp.fetch('https://vision.googleapis.com/v1/files:annotate',{
      method:'post',contentType:'application/json',headers:{'Authorization':'Bearer '+token},
      payload:JSON.stringify({requests:[{inputConfig:{content:base64Data,mimeType:'application/pdf'},features:[{type:'DOCUMENT_TEXT_DETECTION',maxResults:1}],pages:[1,2,3,4,5]}]}),
      muteHttpExceptions:true});
    if(response.getResponseCode()===200){
      var result=JSON.parse(response.getContentText()),allText='';
      if(result.responses&&result.responses[0]&&result.responses[0].responses){
        result.responses[0].responses.forEach(function(p){if(p.fullTextAnnotation)allText+=p.fullTextAnnotation.text+'\n';});
      }
      if(allText.trim())return allText.trim();
    }
  }catch(e){}
  var fileId=null;
  try{
    var pdfFile=DriveApp.createFile(blob);pdfFile.setName('OCR_TEMP_'+new Date().getTime()+'.pdf');
    var token2=ScriptApp.getOAuthToken();
    var copyResponse=UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+pdfFile.getId()+'/copy',{
      method:'post',contentType:'application/json',headers:{'Authorization':'Bearer '+token2},
      payload:JSON.stringify({name:'OCR_TEMP_DOC_'+new Date().getTime(),mimeType:'application/vnd.google-apps.document'}),muteHttpExceptions:true});
    pdfFile.setTrashed(true);
    if(copyResponse.getResponseCode()!==200)throw new Error('Drive copy failed');
    var copiedFile=JSON.parse(copyResponse.getContentText());fileId=copiedFile.id;
    return DocumentApp.openById(fileId).getBody().getText();
  }catch(e){return'';}
  finally{if(fileId){try{DriveApp.getFileById(fileId).setTrashed(true);}catch(e2){}}}
}

function classifyEmail_(subject,body,from) {
  var content=subject+' '+body;
  var excludePatterns=[/研習|講習|訓練|課程|工作坊|workshop/i,/旅遊|出遊|聯誼活動|康樂|郊遊|尾牙|春酒/i,/報名費|學分|研討會|論壇|seminar/i,/成大.*社團|校友.*活動|同學會/i,/議事錄|會議紀錄|紀錄$/i];
  for(var i=0;i<excludePatterns.length;i++){if(excludePatterns[i].test(content))return{isMeeting:false,reason:'排除:'+excludePatterns[i]};}
  if(/85cafe|85c|Cayman\s*85C|Gourmet\s*Master/i.test(from+' '+subject)){if(/董事會|審計委員|股東會|議事手冊|開會通知/i.test(subject))return{isMeeting:true,reason:'85°C董事會/審計委員會/股東會'};}
  if(/臺中律師公會|台中律師公會|tcbar/i.test(from+' '+subject)){if(/理事.*監事|監事.*理事|理監事|會員大會/i.test(content))return{isMeeting:true,reason:'台中律師公會理監事會議'};if(/座談會/i.test(subject)&&!/報名/i.test(subject))return{isMeeting:true,reason:'台中律師公會座談會'};}
  if(/nchu|中興大學|教師申訴|評議委員/i.test(from+' '+subject)){if(/委員會|開會|會議/i.test(content))return{isMeeting:true,reason:'中興大學教師申訴評議委員會'};}
  if(/開會通知|會議通知/i.test(subject)){if(/召開|出席|列席|敬邀|與會|請假/i.test(content))return{isMeeting:true,reason:'通用開會通知'};}
  if(/政府|公所|區公所|市政府|縣政府|局|處|署|部|委員會|育成/i.test(from+' '+subject)){if(/開會|會議|召開|出席/i.test(content))return{isMeeting:true,reason:'政府機關會議'};}
  if(/召開.*(?:會議|大會|委員會|董事會|股東會)/i.test(subject))return{isMeeting:true,reason:'主旨含召開+會議類型'};
  return{isMeeting:false,reason:'不符合條件'};
}

function parseEventInfo_(subject,body,emailDate,ocrText) {
  ocrText=ocrText||'';var content=subject+'\n'+body,allContent=content+'\n'+ocrText;
  var result={title:'',startTime:null,endTime:null,location:'',description:'',zoomLink:''};
  result.title=extractMeetingName_(subject);
  var parsedDate=extractDate_(content,emailDate);
  if(!parsedDate&&ocrText){parsedDate=extractDate_(ocrText,emailDate);}
  if(!parsedDate)return result;
  var parsedTime=extractTime_(content);
  if(parsedTime.hour===null&&ocrText){parsedTime=extractTime_(ocrText);}
  if(parsedTime.hour!==null){result.startTime=new Date(parsedDate.year,parsedDate.month-1,parsedDate.day,parsedTime.hour,parsedTime.minute||0);}
  else{result.startTime=new Date(parsedDate.year,parsedDate.month-1,parsedDate.day,9,0);}
  result.endTime=new Date(result.startTime.getTime()+CONFIG.DEFAULT_DURATION_MINUTES*60000);
  result.location=extractLocation_(content,true);
  if(!result.location&&ocrText){result.location=extractLocation_(ocrText,false);}
  var zoomMatch=allContent.match(/https:\/\/[^\s]*zoom[^\s]*/i);
  if(zoomMatch)result.zoomLink=zoomMatch[0];
  result.description='📧 自動從 Gmail 開會通知建立\n\n主旨：'+subject;
  if(result.zoomLink)result.description+='\n\n🔗 視訊連結：'+result.zoomLink;
  if(ocrText)result.description+='\n\n📷 附件 OCR（節錄）：\n'+ocrText.substring(0,500);
  return result;
}

function extractMeetingName_(subject) {
  var name=subject.replace(/^(RE:|FW:|Fwd:)\s*/gi,'').replace(/^\[.*?\]\s*/,'').replace(/【.*?】\s*/,'').replace(/開會通知\s*[-–—]\s*/,'').replace(/\d{2,4}年\d{1,2}月\d{1,2}日\s*/,'').replace(/\d{1,2}:\d{2}\s*(am|pm)?\s*/gi,'').replace(/出席登記.*$/,'').replace(/（無寄送紙本）/,'').replace(/，請於.*$/,'').trim();
  if(name.length<3)name=subject.replace(/^(RE:|FW:|Fwd:)\s*/gi,'').trim();
  return name;
}

function extractDate_(content,emailDate) {
  var m,emailYear=emailDate.getFullYear();
  m=content.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);if(m)return{year:parseInt(m[1]),month:parseInt(m[2]),day:parseInt(m[3])};
  m=content.match(/(1\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);if(m)return{year:parseInt(m[1])+1911,month:parseInt(m[2]),day:parseInt(m[3])};
  m=content.match(/(1\d{2})\/(\d{1,2})\/(\d{1,2})/);if(m)return{year:parseInt(m[1])+1911,month:parseInt(m[2]),day:parseInt(m[3])};
  m=content.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);if(m){var mo=parseInt(m[1]),da=parseInt(m[2]),yr=emailYear;if(mo<emailDate.getMonth()+1-2)yr++;return{year:yr,month:mo,day:da};}
  return null;
}

function extractTime_(content) {
  var hour=null,minute=0,m;
  m=content.match(/(上午|下午|早上|晚上)\s*(\d{1,2})\s*[時點:：]\s*(\d{0,2})/);
  if(m){hour=parseInt(m[2]);minute=m[3]?parseInt(m[3]):0;if((m[1]==='下午'||m[1]==='晚上')&&hour<12)hour+=12;if((m[1]==='上午'||m[1]==='早上')&&hour===12)hour=0;return{hour:hour,minute:minute};}
  m=content.match(/(\d{1,2})\s*[:：]\s*(\d{2})\s*(am|pm)/i);
  if(m){hour=parseInt(m[1]);minute=parseInt(m[2]);if(m[3].toLowerCase()==='pm'&&hour<12)hour+=12;if(m[3].toLowerCase()==='am'&&hour===12)hour=0;return{hour:hour,minute:minute};}
  m=content.match(/(\d{1,2})\s*[點時]\s*(\d{0,2})\s*分?/);if(m){hour=parseInt(m[1]);minute=m[2]?parseInt(m[2]):0;return{hour:hour,minute:minute};}
  m=content.match(/(\d{1,2})\s*[：:]\s*(\d{2})(?!\d)/);if(m){hour=parseInt(m[1]);minute=parseInt(m[2]);if(hour<=23&&minute<=59)return{hour:hour,minute:minute};}
  return{hour:null,minute:0};
}

function extractLocation_(content,cleanSignature) {
  var m,text=content;
  if(cleanSignature){var sigPatterns=[/={3,}[\s\S]*$/,/會館電話[\s\S]*$/,/會館地址[\s\S]*$/,/---{3,}[\s\S]*$/,/本郵件之資訊可能含有[\s\S]*$/,/Email Disclaimer[\s\S]*$/i];for(var i=0;i<sigPatterns.length;i++)text=text.replace(sigPatterns[i],'');}
  m=text.match(/【地點】\s*(.+?)(?:\r?\n|$)/);if(m)return m[1].trim();
  m=text.match(/(?<!會館)地[點点]\s*[：:]\s*(.+?)(?:\r?\n|$)/);if(m)return m[1].trim();
  m=text.match(/時於\s*(.+?(?:會議室|會議廳))/);if(m)return m[1].trim();
  m=text.match(/於\s*(.+?(?:會議室|會議廳))/);if(m&&m[1].length<=50)return m[1].trim();
  m=text.match(/於\s*(.{2,30}?(?:大樓|樓|會館|辦公室|法院|法庭))\s*(?:舉辦|舉行|召開|開會)/);if(m)return m[1].trim();
  m=text.match(/（([^）]*(?:會議室|大樓|樓|會館|辦公室)[^）]*)）/);if(m)return m[1].trim();
  m=text.match(/[在於]\s*(.{2,30}?(?:會議室|會議廳|會館會議室))/);if(m)return m[1].trim();
  return'';
}

function createCalendarEvent_(eventInfo,originalMsg) {
  try{var calendar=CalendarApp.getCalendarById(CONFIG.COURT_CALENDAR_ID);if(!calendar)return null;
  return calendar.createEvent(CONFIG.EVENT_PREFIX+eventInfo.title,eventInfo.startTime,eventInfo.endTime,{description:eventInfo.description,location:eventInfo.location||eventInfo.zoomLink||''});}
  catch(e){Logger.log('建立事件失敗：'+e.message);return null;}
}

function isDuplicate_(eventInfo) {
  try{var calendar=CalendarApp.getCalendarById(CONFIG.COURT_CALENDAR_ID);if(!calendar)return false;
  var dayStart=new Date(eventInfo.startTime);dayStart.setHours(0,0,0,0);var dayEnd=new Date(eventInfo.startTime);dayEnd.setHours(23,59,59,999);
  var events=calendar.getEvents(dayStart,dayEnd),targetTitle=eventInfo.title.toLowerCase();
  for(var i=0;i<events.length;i++){var existingTitle=events[i].getTitle().replace(CONFIG.EVENT_PREFIX,'').toLowerCase();
  if(existingTitle.includes(targetTitle)||targetTitle.includes(existingTitle))return true;
  if(events[i].getStartTime().getTime()===eventInfo.startTime.getTime())return true;}return false;}
  catch(e){return false;}
}

function getOrCreateLabel_(labelName){var label=GmailApp.getUserLabelByName(labelName);if(!label)label=GmailApp.createLabel(labelName);return label;}
function resetLabels(){var label=GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL);if(!label)return;var threads=label.getThreads();for(var i=0;i<threads.length;i++)threads[i].removeLabel(label);Logger.log('✅ 已移除標籤');}
function uninstall(){var triggers=ScriptApp.getProjectTriggers();triggers.forEach(function(t){if(t.getHandlerFunction()==='scanMeetingEmails')ScriptApp.deleteTrigger(t);});Logger.log('✅ 已移除觸發器');}

function dryRun(){
  var cutoffDate=new Date();cutoffDate.setDate(cutoffDate.getDate()-CONFIG.SEARCH_DAYS_BACK);
  var dateStr=Utilities.formatDate(cutoffDate,'Asia/Taipei','yyyy/MM/dd');
  var threads=GmailApp.search('after:'+dateStr+' '+CONFIG.SEARCH_SUBJECT_QUERY,0,50);
  for(var i=0;i<threads.length;i++){
    var msg=threads[i].getMessages()[0],classification=classifyEmail_(msg.getSubject(),msg.getPlainBody(),msg.getFrom());
    var ocrText=(CONFIG.ENABLE_OCR&&classification.isMeeting)?ocrAttachments_(msg):'';
    var eventInfo=parseEventInfo_(msg.getSubject(),msg.getPlainBody(),msg.getDate(),ocrText);
    Logger.log((classification.isMeeting?'✅':'❌')+' | '+msg.getSubject());
    if(classification.isMeeting&&eventInfo.startTime)Logger.log('   時間:'+eventInfo.startTime+(eventInfo.location?' 地點:'+eventInfo.location:''));
  }
}
