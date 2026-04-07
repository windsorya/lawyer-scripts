// LINE Bot v2.5 - 收發文自動化 + 全時段自動回覆 + 統一 Push 備查
// v2.0→v2.1: isDuplicate 改為只擋同用戶同內容重複訊息，不擋連續不同訊息
// v2.1→v2.2: 黑名單過濾垃圾訊息 + 備查顯示 userId
// v2.2→v2.3: 律師 LINE 指令封鎖垃圾用戶（封鎖+名字 → 查 Notion → blockUser）
// v2.3→v2.4: 收發文自動化（file message → Drive 上傳 + Claude 辨識 + 擬稿 + 律師審核）
// v2.4→v2.5: 收發文 bug fix（律師限定）+ Claude 動態擬稿 + 草稿獨立泡泡
// 2026-04-06

// ⚠️ 不要跑 setupAllProperties — Script Properties 已手動設定好
// 此函式僅用於檢查目前的 properties 是否齊全
function checkProperties(){
  var p=PropertiesService.getScriptProperties();
  var keys=['LINE_CHANNEL_ACCESS_TOKEN','LINE_CHANNEL_SECRET','ANTHROPIC_API_KEY','LAWYER_LINE_USER_ID','NOTION_API_KEY','NOTION_DB_ID'];
  for(var i=0;i<keys.length;i++){
    var val=p.getProperty(keys[i]);
    Logger.log(keys[i]+': '+(val?val.substring(0,10)+'... ('+val.length+'字)':'❌ 未設定'));
  }
}

function getConfig_(){
  var p=PropertiesService.getScriptProperties();
  return{
    LINE_CHANNEL_ACCESS_TOKEN:p.getProperty('LINE_CHANNEL_ACCESS_TOKEN'),
    LINE_CHANNEL_SECRET:p.getProperty('LINE_CHANNEL_SECRET'),
    ANTHROPIC_API_KEY:p.getProperty('ANTHROPIC_API_KEY'),
    LAWYER_LINE_USER_ID:p.getProperty('LAWYER_LINE_USER_ID'),
    NOTION_API_KEY:p.getProperty('NOTION_API_KEY'),
    NOTION_DB_ID:p.getProperty('NOTION_DB_ID')
  };
}

// ===== 黑名單過濾 =====
function isBlockedUser_(userId){
  try{
    var raw=PropertiesService.getScriptProperties().getProperty('BLOCKED_USER_IDS');
    if(!raw)return false;
    var list=JSON.parse(raw);
    return Array.isArray(list)&&list.indexOf(userId)>=0;
  }catch(e){return false;}
}

function doPost(e){
  try{
    var body=e.postData.contents;
    var data=JSON.parse(body);
    var events=data.events||[];
    var CONFIG=getConfig_();
    for(var i=0;i<events.length;i++){
      if(events[i].type!=='message')continue;
      var msg=events[i].message;
      var srcUserId=events[i].source.userId;
      var lawyerId=CONFIG.LAWYER_LINE_USER_ID;
      var scriptProps=PropertiesService.getScriptProperties();

      // ===== 人工接管機制 =====
      // 追蹤最近發訊的非律師用戶（只追蹤文字訊息）
      if(srcUserId!==lawyerId&&msg&&msg.type==='text'){
        scriptProps.setProperty('last_message_user_id',srcUserId);
      }

      // 律師接管指令：0/1/00/11（在律師其他指令前處理）
      if(msg&&msg.type==='text'&&srcUserId===lawyerId&&lawyerId!==''){
        var takeoverCmd=msg.text.trim();
        if(takeoverCmd==='0'){
          var lastUser=scriptProps.getProperty('last_message_user_id');
          if(lastUser){
            scriptProps.setProperty('takeover_'+lastUser,String(Date.now()+2*60*60*1000));
            scriptProps.setProperty('last_paused_user_id',lastUser);
            Logger.log('接管：暫停用戶 '+lastUser+' 2小時');
          }
          continue;
        }
        if(takeoverCmd==='1'){
          var lastPaused=scriptProps.getProperty('last_paused_user_id');
          if(lastPaused){scriptProps.deleteProperty('takeover_'+lastPaused);}
          Logger.log('接管：恢復用戶 '+lastPaused);
          continue;
        }
        if(takeoverCmd==='00'){
          scriptProps.setProperty('takeover_global',String(Date.now()+2*60*60*1000));
          Logger.log('接管：全域暫停 2小時');
          continue;
        }
        if(takeoverCmd==='11'){
          var allProps=scriptProps.getProperties();
          Object.keys(allProps).filter(function(k){return k.indexOf('takeover_')===0;}).forEach(function(k){scriptProps.deleteProperty(k);});
          scriptProps.deleteProperty('last_paused_user_id');
          Logger.log('接管：全域恢復，清除所有暫停');
          continue;
        }
      }
      // ===== 人工接管機制 END =====

      // 檔案訊息：僅律師走收發文流程，非律師回 fallback
      if(msg&&msg.type==='file'){
        if(srcUserId===lawyerId){
          handleFileMessage_(events[i]);
        }else if(!isBlockedUser_(srcUserId)){
          replyToLine_(events[i].replyToken,'您好，目前僅支援文字訊息的自動處理。\n\n如有法律問題，歡迎直接用文字描述您的狀況，律師會儘快回覆您。',CONFIG);
        }
        continue;
      }

      // 律師文字指令（封鎖/送出/改）
      if(msg&&msg.type==='text'&&srcUserId===lawyerId){
        var txt=msg.text.trim();
        if(txt.indexOf('封鎖')===0){
          var targetName=txt.substring(2).trim();
          if(targetName){handleBlockCommand_(events[i].replyToken,targetName);continue;}
        }
        if(txt==='送出'){handleSendCommand_(events[i].replyToken);continue;}
        if(txt.indexOf('改 ')===0){
          var editInstruction=txt.substring(2).trim();
          if(editInstruction){handleEditCommand_(events[i].replyToken,editInstruction);continue;}
        }
        // 律師發的其他訊息不觸發自動回覆
        continue;
      }

      // ===== 接管暫停檢查 =====
      var globalExpiry=scriptProps.getProperty('takeover_global');
      if(globalExpiry&&Date.now()<Number(globalExpiry)){
        Logger.log('全域接管中，略過自動回覆：'+srcUserId);
        continue;
      }else if(globalExpiry){
        scriptProps.deleteProperty('takeover_global');
      }
      var userExpiry=scriptProps.getProperty('takeover_'+srcUserId);
      if(userExpiry&&Date.now()<Number(userExpiry)){
        Logger.log('用戶接管中，略過自動回覆：'+srcUserId);
        continue;
      }else if(userExpiry){
        scriptProps.deleteProperty('takeover_'+srcUserId);
      }
      // ===== 接管暫停檢查 END =====

      processMessageEvent_(events[i]);
    }
  }catch(err){Logger.log('doPost error: '+err.message);}
  return ContentService.createTextOutput('OK');
}

// ===== 主流程 =====
function processMessageEvent_(event){
  var CONFIG=getConfig_();
  var replyToken=event.replyToken;
  var userId=event.source.userId;
  if(isBlockedUser_(userId))return;
  var timestamp=event.timestamp;
  var messageType=event.message.type;
  var messageText=event.message.text||'';

  // 非文字訊息
  if(messageType!=='text'){
    replyToLine_(replyToken,'您好，目前僅支援文字訊息的自動處理。\n\n如有法律問題，歡迎直接用文字描述您的狀況，律師會儘快回覆您。',CONFIG);
    return;
  }
  if(!messageText.trim())return;
  if(isDuplicate_(userId,messageText))return;

  // 記錄最近訊息的 userId（用於抓律師自己的 user ID）
  PropertiesService.getScriptProperties().setProperty('LAST_USER_ID',userId);

  var displayName=getUserDisplayName_(userId,CONFIG);

  // ── 簡單問候過濾 ──
  var greetingReply=handleGreeting_(messageText);
  if(greetingReply){
    replyToLine_(replyToken,greetingReply,CONFIG);
    return;
  }

  // ── 紅旗偵測 ──
  var redFlagResult=detectRedFlag_(messageText);
  if(redFlagResult.isRedFlag){
    var alertText='🚨 高風險當事人攔截\n\n👤 '+displayName+'\n🔑 '+userId+'\n🕐 '+formatTimestamp_(timestamp)+'\n📝 原始訊息：\n'+truncate_(messageText,200)+'\n\n───────────\n⚠️ 紅旗指標：\n'+redFlagResult.flags.join('\n')+'\n\n💡 建議先評估再回覆。';
    pushToLawyer_(alertText,CONFIG);
    writeToNotion_({displayName:displayName,userId:userId,messageText:messageText,caseType:'待判斷',replyMode:'紅旗攔截',claudeReply:'',status:'紅旗待審核',timestamp:timestamp},CONFIG);
    return;
  }

  // ── 多訊息合併（5 分鐘窗口）──
  var mergedMessage=mergeRecentMessages_(userId,messageText);

  // ── 回頭客偵測（查 Notion）──
  var history=getNotionHistory_(userId,CONFIG);

  // ── 案件類型辨識 ──
  var caseType=detectCaseType_(mergedMessage);

  // ── Claude 回覆（統一 Sonnet 4.6）──
  var claudeResponse=null;
  try{
    claudeResponse=callClaude_(mergedMessage,displayName,history,CONFIG);
  }catch(err){Logger.log('Claude API error: '+err.message);}

  if(claudeResponse){
    // 1. Reply API 秒回民眾（免費）
    replyToLine_(replyToken,claudeResponse,CONFIG);

    // 2. Push 備查給律師（統一格式）
    var isWH=isWorkHours_();
    var timeLabel=isWH?'工時':'非工時';
    var lawyerText='📨 LINE 諮詢（已自動回覆・'+timeLabel+'）\n\n👤 '+displayName+(history?' 🔄 回頭客':'')+'\n🔑 '+userId+'\n🕐 '+formatTimestamp_(timestamp)+'\n💡 '+caseType+'\n\n📝 民眾：\n'+truncate_(mergedMessage,300)+'\n\n───────────\n🤖 已回覆：\n'+truncate_(claudeResponse,300)+'\n───────────\n\n▶ 如需補充回覆，請至 LINE OA 後台';
    pushToLawyer_(lawyerText,CONFIG);

    // 3. 寫入 Notion
    writeToNotion_({displayName:displayName,userId:userId,messageText:mergedMessage,caseType:caseType,replyMode:'自動回覆',claudeReply:claudeResponse,status:'已自動回覆',timestamp:timestamp},CONFIG);
  }else{
    // Claude API 失敗 → fallback
    var fallback=getFallbackMessage_();
    replyToLine_(replyToken,fallback,CONFIG);
    pushToLawyer_('⚠️ Claude API 失敗，已送 fallback\n👤 '+displayName+'\n🔑 '+userId+'\n📝 '+truncate_(mergedMessage,100),CONFIG);
    writeToNotion_({displayName:displayName,userId:userId,messageText:mergedMessage,caseType:caseType,replyMode:'fallback',claudeReply:fallback,status:'已自動回覆(fallback)',timestamp:timestamp},CONFIG);
  }
}

// ===== 簡單問候過濾 =====
function handleGreeting_(text){
  var t=text.trim();
  if(t.length>10)return null;
  var greetings=/^(你好|您好|嗨|哈囉|hi|hello|hey|早安|午安|晚安|早|安安)$/i;
  var thanks=/^(謝謝|感謝|謝謝你|謝謝您|感謝你|感謝您|謝啦|3q|thank|thanks)$/i;
  var ack=/^(好的|好|收到|了解|知道了|ok|嗯|嗯嗯|喔|喔喔|好喔)$/i;

  if(greetings.test(t)){
    return '您好！如果有任何法律問題，歡迎直接描述您的狀況，律師會儘快回覆您。';
  }
  if(thanks.test(t)){
    return '不客氣！如果後續有任何法律問題，隨時可以詢問。';
  }
  if(ack.test(t))return null;
  return null;
}

// ===== 多訊息合併（Cache 5 分鐘窗口）=====
function mergeRecentMessages_(userId,currentMessage){
  var cache=CacheService.getScriptCache();
  var key='linebot_ctx_'+userId;
  var existing=cache.get(key);
  var merged=currentMessage;
  if(existing){
    var prev=existing.split('\n---\n');
    prev.push(currentMessage);
    if(prev.length>3)prev=prev.slice(-3);
    merged=prev.join('\n');
    cache.put(key,prev.join('\n---\n'),300);
  }else{
    cache.put(key,currentMessage,300);
  }
  return merged;
}

// ===== 回頭客偵測（查 Notion）=====
function getNotionHistory_(userId,config){
  if(!config.NOTION_API_KEY||!config.NOTION_DB_ID)return null;
  try{
    var payload={
      filter:{
        property:'LINE User ID',
        rich_text:{equals:userId}
      },
      sorts:[{property:'時間戳',direction:'descending'}],
      page_size:3
    };
    var response=UrlFetchApp.fetch('https://api.notion.com/v1/databases/'+config.NOTION_DB_ID+'/query',{
      method:'post',
      headers:{
        'Authorization':'Bearer '+config.NOTION_API_KEY,
        'Content-Type':'application/json',
        'Notion-Version':'2022-06-28'
      },
      payload:JSON.stringify(payload),
      muteHttpExceptions:true
    });
    if(response.getResponseCode()!==200){
      Logger.log('Notion query fail: '+response.getResponseCode());
      return null;
    }
    var data=JSON.parse(response.getContentText());
    if(!data.results||data.results.length===0)return null;
    var summaries=[];
    for(var i=0;i<data.results.length&&i<3;i++){
      var props=data.results[i].properties;
      var msg=extractRichText_(props['訊息內容']);
      var ctype=props['案件類型']&&props['案件類型'].select?props['案件類型'].select.name:'';
      var ts=props['時間戳']&&props['時間戳'].date?props['時間戳'].date.start:'';
      if(msg)summaries.push('['+ts+'] '+ctype+'：'+truncate_(msg,60));
    }
    return summaries.length>0?summaries.join('\n'):null;
  }catch(err){
    Logger.log('Notion history error: '+err.message);
    return null;
  }
}

function extractRichText_(prop){
  if(!prop||!prop.rich_text||prop.rich_text.length===0)return'';
  return prop.rich_text.map(function(t){return t.plain_text||'';}).join('');
}

// ===== Claude 呼叫（統一 Sonnet 4.6）=====
function callClaude_(message,displayName,history,config){
  var model='claude-sonnet-4-6';
  var maxTokens=800;
  var systemPrompt=getAutoReplyPrompt_();

  var userContent='民眾顯示名稱：'+displayName+'\n\n';
  if(history){
    userContent+='【此民眾過去曾諮詢過，以下是歷史紀錄】\n'+history+'\n\n請根據歷史紀錄，在回覆中自然提及「您之前有詢問過...」，展現事務所有記錄、有追蹤的專業形象。如果歷史案件類型和本次相同，可以適度提醒進展和時效。\n\n';
  }
  userContent+='民眾訊息：\n'+message;

  var payload={
    model:model,
    max_tokens:maxTokens,
    system:systemPrompt,
    messages:[{role:'user',content:userContent}]
  };
  var options={
    method:'post',
    contentType:'application/json',
    headers:{'x-api-key':config.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
    payload:JSON.stringify(payload),
    muteHttpExceptions:true
  };
  var response=UrlFetchApp.fetch('https://api.anthropic.com/v1/messages',options);
  var code=response.getResponseCode();
  if(code!==200){
    Logger.log('Claude API non-200: '+code+' '+response.getContentText());
    return null;
  }
  var result=JSON.parse(response.getContentText());
  var textBlocks=(result.content||[]).filter(function(b){return b.type==='text';});
  if(textBlocks.length===0)return null;
  var reply=textBlocks.map(function(b){return b.text;}).join('');

  // 硬截斷保護：1500 字元上限
  if(reply.length>1500){
    var cutPos=reply.lastIndexOf('。',1450);
    if(cutPos<800)cutPos=reply.lastIndexOf('，',1450);
    if(cutPos<800)cutPos=1450;
    reply=reply.substring(0,cutPos+1)+'\n\n...完整分析需要了解更多案情細節，歡迎預約付費諮詢。';
  }
  return reply;
}

// ===== System Prompt =====
function getAutoReplyPrompt_(){
  var p='';
  p+='你是王志文律師的 LINE 官方帳號自動回覆系統。王律師執業 15 年，位於台中，專長刑事辯護、詐欺案件、民事求償、土地行政、家事案件。\n\n';
  p+='## 你的任務\n收到民眾法律諮詢訊息後，產出一段可直接傳送的 LINE 回覆。\n\n';
  p+='## 回覆策略（核心鐵律）\n1. 展現專業但不給完整答案\n2. 量化不行動的後果（法律風險、時效風險、生活影響，用損失框架激發行動）\n3. 引導付費諮詢（自然收尾到費用和預約）\n4. 真實時間壓力（每則回覆帶一個具體的法律期間或程序節點）\n\n';
  p+='## 回覆骨架（五段式，350-500 字）\n【第一段】用民眾的語言重述他的處境（鏡像回應），1-2 句\n【第二段】三層後果（法律風險 + 程序風險 + 生活影響），用連貫段落不用條列\n【第三段】社會證明 + 時間壓力\n【第四段】引導預約諮詢（見下方預約規則）\n【第五段】免責聲明（固定，不可省略）\n\n';
  p+='## 預約規則（極重要，不可違反）\n- 絕對不可以自行提供具體的可預約時段（如週一下午、週三上午等），因為系統無法即時查詢律師行事曆\n- 正確做法：引導民眾填寫預約表單，或請民眾告知方便的時段，律師確認後回覆\n- 寫法範例：「您方便的時間是平日哪幾天或哪個時段？我確認行程後儘快回覆您。」\n- 僅限平日，不提週末或假日\n\n';
  p+='## 免責聲明（每則結尾必附，一字不改）\n以上內容僅供初步參考，因為非當面法律諮詢，無法完整了解您案件的全部細節，可能有誤差。建議您來所進行完整的付費法律諮詢，律師能在充分了解案情後，給您最準確的法律建議。\n\n';
  p+='## 費用（金額固定，不可寫錯）\n- 30 分鐘 3,500 元 / 60 分鐘 5,000 元\n- 諮詢費可全額折抵委任律師費\n- 對方表達費用顧慮時，只報 3,500 元（低錨點原則）\n- 預約連結：https://forms.gle/nYMMvXphyJXsB53DA\n\n';
  p+='## 稱呼規則\n- 預設用姓加先生或小姐，無法判斷姓名或性別用您好\n- 一律用您，禁止用你或妳\n\n';
  p+='## 回頭客規則\n- 如果訊息中包含「此民眾過去曾諮詢過」的歷史紀錄，必須在回覆第一段自然提及\n- 範例：「您好，您之前有來詢問過帳戶凍結的問題，不知道後來處理得如何？」\n- 這是展現事務所有追蹤、有記錄的最強信任訊號\n\n';
  p+='## 多訊息處理\n- 如果民眾訊息包含多段（用換行分隔），代表是分多則傳送的\n- 請綜合所有內容一併回覆，不要只回應最後一則\n\n';
  p+='## 刑事案件特殊規則\n- 有辯護空間的案件用希望加關鍵切入，不直接痛點放大\n- 案情不明時用法定刑範圍激發痛點，不做個案預測\n- 不自動判斷告訴乃論（需查表才能判斷）\n\n';
  p+='## 格式規則\n- LINE 分行：每段空一行，手機閱讀友善\n- 口語自然，像真人在打字\n- 不用表情符號\n- 不說歡迎加入或隨時聯繫\n- 不用一定、保證、絕對\n- 不給確定性法律結論、不預測判決結果\n\n';
  p+='## 絕對禁止\n- 不得提供完整法律分析（留白才有來所動力）\n- 不得說隨時聯繫（暗示 24 小時待命）\n- 不使用 AI 慣用語（非常理解您的焦慮、請放心、一定會）\n- 不冒充律師本人的語氣\n- 不得自行提供具體可預約時段\n\n';
  p+='## 字數限制（極重要）\n回覆總長度嚴格控制在 500 字以內（含免責聲明）。超過會被系統截斷，民眾會看到不完整訊息。寧可精簡也不要超長。\n\n';
  p+='## 輸出\n直接輸出可傳送的 LINE 回覆文字，不加任何前言、分析或後記。';
  return p;
}

// ===== 工具函式 =====
function isWorkHours_(){
  var now=new Date();
  var taipeiOffset=8*60;
  var utcMinutes=now.getUTCHours()*60+now.getUTCMinutes();
  var taipeiMinutes=(utcMinutes+taipeiOffset)%(24*60);
  var taipeiHour=Math.floor(taipeiMinutes/60);
  var taipeiDay=getTaipeiDayOfWeek_(now);
  if(taipeiDay>=1&&taipeiDay<=5&&taipeiHour>=9&&taipeiHour<18)return true;
  return false;
}

function getTaipeiDayOfWeek_(date){
  var taipeiTime=new Date(date.getTime()+8*60*60*1000);
  return taipeiTime.getUTCDay();
}

function isDuplicate_(userId,messageText){
  var cache=CacheService.getScriptCache();
  var key='linebot_dedup_'+userId+'_'+messageText.substring(0,50);
  if(cache.get(key))return true;
  cache.put(key,'1',30);
  return false;
}

function detectRedFlag_(message){
  var flags=[];var text=message;
  var r=['身敗名裂','砸在臉上','讓他們跪','毀掉他','讓他付出代價','報復','讓他死','弄死'];
  for(var i=0;i<r.length;i++){if(text.indexOf(r[i])>=0){flags.push('報復驅動：'+r[i]);break;}}
  var u=['三天內','馬上道歉','逼對方撤告','讓他被開除','立刻公開','明天就要搞定'];
  for(var i=0;i<u.length;i++){if(text.indexOf(u[i])>=0){flags.push('期望不切實際：'+u[i]);break;}}
  var c=['按這套','照劇本','請律師直接利用','我已經擬好','按我的計畫'];
  for(var i=0;i<c.length;i++){if(text.indexOf(c[i])>=0){flags.push('當事人主導策略：'+c[i]);break;}}
  var x=['核武級','極限施壓','不對稱攻擊','殺手鐧','毀滅性','焦土'];
  for(var i=0;i<x.length;i++){if(text.indexOf(x[i])>=0){flags.push('極端用語：'+x[i]);break;}}
  return{isRedFlag:flags.length>=2,flags:flags};
}

function detectCaseType_(message){
  var t=message;
  if(/詐欺|帳戶凍結|警示帳戶|人頭|洗錢/.test(t))return'詐欺/人頭帳戶';
  if(/借錢|欠錢|違約|賠償|侵權|損害/.test(t))return'民事求償';
  if(/地政|訴願|處分|建管|稅務|行政/.test(t))return'土地/行政';
  if(/離婚|監護|繼承|贍養|扶養|家暴|保護令/.test(t))return'家事';
  if(/毒品|傷害|竊盜|妨害名譽|酒駕|過失|恐嚇|性侵|強制|公共危險/.test(t))return'其他刑事';
  if(/開庭|傳票|筆錄|被告|起訴/.test(t))return'刑事（待細分）';
  return'待判斷';
}

function replyToLine_(replyToken,text,config){
  if(!replyToken||!text)return;
  var messages=buildLineTextMessages_(text);
  try{
    var response=UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply',{
      method:'post',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+config.LINE_CHANNEL_ACCESS_TOKEN},
      payload:JSON.stringify({replyToken:replyToken,messages:messages}),
      muteHttpExceptions:true
    });
    if(response.getResponseCode()!==200)Logger.log('LINE Reply fail: '+response.getResponseCode()+' '+response.getContentText());
  }catch(err){Logger.log('LINE Reply error: '+err.message);}
}

function pushToLawyer_(text,config){
  if(!text||!config.LAWYER_LINE_USER_ID)return;
  var messages=buildLineTextMessages_(text);
  try{
    var response=UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push',{
      method:'post',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+config.LINE_CHANNEL_ACCESS_TOKEN},
      payload:JSON.stringify({to:config.LAWYER_LINE_USER_ID,messages:messages.slice(0,5)}),
      muteHttpExceptions:true
    });
    if(response.getResponseCode()!==200)Logger.log('LINE Push fail: '+response.getResponseCode()+' '+response.getContentText());
  }catch(err){Logger.log('LINE Push error: '+err.message);}
}

function buildLineTextMessages_(text){
  var MAX_LEN=4900;var messages=[];
  if(text.length<=MAX_LEN){messages.push({type:'text',text:text});}
  else{
    var lines=text.split('\n');var current='';
    for(var i=0;i<lines.length;i++){
      if((current+'\n'+lines[i]).length>MAX_LEN&&current){messages.push({type:'text',text:current.trim()});current=lines[i];}
      else{current=current?current+'\n'+lines[i]:lines[i];}
    }
    if(current.trim())messages.push({type:'text',text:current.trim()});
  }
  return messages.slice(0,5);
}

function getUserDisplayName_(userId,config){
  try{
    var response=UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/'+userId,{
      method:'get',
      headers:{'Authorization':'Bearer '+config.LINE_CHANNEL_ACCESS_TOKEN},
      muteHttpExceptions:true
    });
    if(response.getResponseCode()===200){
      var profile=JSON.parse(response.getContentText());
      return profile.displayName||'未知';
    }
  }catch(err){Logger.log('displayName error: '+err.message);}
  return'未知';
}

function writeToNotion_(data,config){
  if(!config.NOTION_API_KEY||!config.NOTION_DB_ID){Logger.log('Notion config missing');return;}
  var taipeiNow=Utilities.formatDate(new Date(),'Asia/Taipei',"yyyy-MM-dd'T'HH:mm:ss'+08:00'");
  var dateStr=Utilities.formatDate(new Date(),'Asia/Taipei','yyyy-MM-dd');
  var title=data.displayName+' '+dateStr;
  var properties={
    '標題':{title:[{text:{content:title}}]},
    'LINE User ID':{rich_text:[{text:{content:data.userId||''}}]},
    '訊息內容':{rich_text:[{text:{content:truncate_(data.messageText,2000)}}]},
    '案件類型':{select:{name:data.caseType||'待判斷'}},
    '回覆模式':{select:{name:data.replyMode||'自動回覆'}},
    'Claude 回覆內容':{rich_text:[{text:{content:truncate_(data.claudeReply||'',2000)}}]},
    '狀態':{select:{name:data.status||'已自動回覆'}},
    '時間戳':{date:{start:taipeiNow}},
    '下次追蹤日':{date:{start:getNextTrackDate_(dateStr)}}
  };
  try{
    var response=UrlFetchApp.fetch('https://api.notion.com/v1/pages',{
      method:'post',
      headers:{'Authorization':'Bearer '+config.NOTION_API_KEY,'Content-Type':'application/json','Notion-Version':'2022-06-28'},
      payload:JSON.stringify({parent:{database_id:config.NOTION_DB_ID},properties:properties}),
      muteHttpExceptions:true
    });
    if(response.getResponseCode()!==200)Logger.log('Notion fail: '+response.getResponseCode()+' '+response.getContentText());
    else Logger.log('Notion ok: '+title);
  }catch(err){Logger.log('Notion error: '+err.message);}
}

function getNextTrackDate_(dateStr){
  var d=new Date(dateStr);d.setDate(d.getDate()+2);
  return Utilities.formatDate(d,'Asia/Taipei','yyyy-MM-dd');
}

function getFallbackMessage_(){
  return'您好，感謝您的詢問。\n\n我們已收到您的訊息，王志文律師將於上班時間（週一至週五 09:00-18:00）儘快回覆您。\n\n如果您的情況比較緊急，也可以先填寫預約表單，律師會優先處理：\nhttps://forms.gle/nYMMvXphyJXsB53DA\n\n諮詢費用：30分鐘3,500元/60分鐘5,000元\n諮詢費可全額折抵委任律師費。';
}

function truncate_(text,maxLen){if(!text)return'';return text.length>maxLen?text.substring(0,maxLen)+'...':text;}
function formatTimestamp_(ts){if(!ts)return'';var date=new Date(ts);return Utilities.formatDate(date,'Asia/Taipei','yyyy-MM-dd HH:mm');}

// ===== 測試函式 =====
function testAutoReply(){
  var CONFIG=getConfig_();
  var reply=callClaude_('我被告詐欺，帳戶被凍結了，該怎麼辦？','測試用戶',null,CONFIG);
  Logger.log('Reply: '+reply);
  Logger.log('Length: '+(reply?reply.length:'null'));
}
function testNotion(){
  var CONFIG=getConfig_();
  writeToNotion_({displayName:'測試',userId:'test123',messageText:'測試訊息',caseType:'測試',replyMode:'測試',claudeReply:'測試回覆',status:'測試',timestamp:Date.now()},CONFIG);
}
function testNotionHistory(){
  var CONFIG=getConfig_();
  var history=getNotionHistory_('test123',CONFIG);
  Logger.log('History: '+history);
}
function testPush(){
  var CONFIG=getConfig_();
  Logger.log('LAWYER_ID: '+CONFIG.LAWYER_LINE_USER_ID);
  pushToLawyer_('🔔 Push 測試：如果你看到這則訊息，代表通知功能正常。',CONFIG);
}

// ===== 律師指令：封鎖用戶 =====
// 用法：律師在 LINE 傳「封鎖 顯示名稱」→ 查 Notion 取 userId → blockUser
function handleBlockCommand_(replyToken,targetName){
  var CONFIG=getConfig_();
  var payload={
    filter:{property:'標題',title:{contains:targetName}},
    sorts:[{property:'時間戳',direction:'descending'}],
    page_size:5
  };
  try{
    var response=UrlFetchApp.fetch('https://api.notion.com/v1/databases/'+CONFIG.NOTION_DB_ID+'/query',{
      method:'post',
      headers:{
        'Authorization':'Bearer '+CONFIG.NOTION_API_KEY,
        'Content-Type':'application/json',
        'Notion-Version':'2022-06-28'
      },
      payload:JSON.stringify(payload),
      muteHttpExceptions:true
    });
    if(response.getResponseCode()!==200){
      Logger.log('handleBlockCommand_ Notion fail: '+response.getResponseCode()+' '+response.getContentText());
      replyToLine_(replyToken,'❌ Notion 查詢失敗（HTTP '+response.getResponseCode()+'）',CONFIG);
      return;
    }
    var data=JSON.parse(response.getContentText());
    if(!data.results||data.results.length===0){
      replyToLine_(replyToken,'❌ 找不到 '+targetName+' 的紀錄',CONFIG);
      return;
    }
    // 取最新的（已按時間戳降序）
    var page=data.results[0];
    var props=page.properties;
    var targetUserId=extractRichText_(props['LINE User ID']);
    if(!targetUserId){
      replyToLine_(replyToken,'❌ 找到 '+targetName+' 的紀錄但缺少 LINE User ID',CONFIG);
      return;
    }
    blockUser(targetUserId);
    var displayName=getUserDisplayName_(targetUserId,CONFIG);
    var shortId=targetUserId.substring(0,8)+'...';
    replyToLine_(replyToken,'✅ 已封鎖 '+displayName+' ('+shortId+')',CONFIG);
  }catch(err){
    Logger.log('handleBlockCommand_ error: '+err.message);
    replyToLine_(replyToken,'❌ 封鎖指令執行失敗：'+err.message,CONFIG);
  }
}

// ===== 修復工具 =====
// 用 @628xgdmn 的 Channel ID + Secret 重新發行 Access Token，並自動更新 Script Properties
// ===== 黑名單管理工具 =====
function blockUser(userId){
  var p=PropertiesService.getScriptProperties();
  var raw=p.getProperty('BLOCKED_USER_IDS');
  var list=[];
  try{if(raw)list=JSON.parse(raw);}catch(e){}
  if(list.indexOf(userId)<0){
    list.push(userId);
    p.setProperty('BLOCKED_USER_IDS',JSON.stringify(list));
    Logger.log('已封鎖：'+userId+'，目前共'+list.length+'筆');
  }else{
    Logger.log('已在黑名單中：'+userId);
  }
}

function unblockUser(userId){
  var p=PropertiesService.getScriptProperties();
  var raw=p.getProperty('BLOCKED_USER_IDS');
  var list=[];
  try{if(raw)list=JSON.parse(raw);}catch(e){}
  var idx=list.indexOf(userId);
  if(idx>=0){
    list.splice(idx,1);
    p.setProperty('BLOCKED_USER_IDS',JSON.stringify(list));
    Logger.log('已解除封鎖：'+userId+'，目前共'+list.length+'筆');
  }else{
    Logger.log('不在黑名單中：'+userId);
  }
}

function listBlockedUsers(){
  var raw=PropertiesService.getScriptProperties().getProperty('BLOCKED_USER_IDS');
  if(!raw){Logger.log('黑名單為空');return;}
  var list=[];
  try{list=JSON.parse(raw);}catch(e){Logger.log('解析失敗：'+raw);return;}
  if(list.length===0){Logger.log('黑名單為空');}
  else{Logger.log('共'+list.length+'筆封鎖：\n'+list.join('\n'));}
}

// ===== 收發文自動化 =====
// Drive 資料夾 ID：100.收發文 (1B2jUNqxT8fsSCF10Z3dSDjDJHu8cEJ0b)
var MAIL_FOLDER_ID_='1B2jUNqxT8fsSCF10Z3dSDjDJHu8cEJ0b';

function handleFileMessage_(event){
  var CONFIG=getConfig_();
  var messageId=event.message.id;
  var fileName=event.message.fileName||('doc_'+messageId+'.pdf');

  // 1. 下載檔案
  var fileBlob=downloadFromLine_(messageId,fileName,CONFIG);
  if(!fileBlob){
    pushToLawyer_('❌ 收發文：LINE 檔案下載失敗（messageId: '+messageId+'）',CONFIG);
    return;
  }

  // 2. 取 base64 供 Claude 辨識（getBytes() 不消耗 Blob，可多次呼叫）
  var fileBase64=Utilities.base64Encode(fileBlob.getBytes());

  // 3. 上傳到 Drive
  var driveFileUrl=uploadToDrive_(fileBlob,fileName);

  // 4. Claude 辨識文件
  var classifyResult=classifyDocument_(fileBase64,CONFIG);

  // 5. 擬訊息（Claude 動態生成）
  var draftMessage=draftForwardMessageClaude_(classifyResult,CONFIG);

  // 6. 推審核給律師
  pushReviewToLawyer_(classifyResult,draftMessage,driveFileUrl,CONFIG);
}

// 從 LINE Content API 下載檔案二進位
function downloadFromLine_(messageId,fileName,config){
  try{
    var response=UrlFetchApp.fetch(
      'https://api-data.line.me/v2/bot/message/'+messageId+'/content',
      {
        method:'get',
        headers:{'Authorization':'Bearer '+config.LINE_CHANNEL_ACCESS_TOKEN},
        muteHttpExceptions:true
      }
    );
    if(response.getResponseCode()!==200){
      Logger.log('LINE Content API fail: '+response.getResponseCode()+' '+response.getContentText());
      return null;
    }
    return response.getBlob().setName(fileName);
  }catch(err){
    Logger.log('downloadFromLine_ error: '+err.message);
    return null;
  }
}

// 上傳到 Drive 的「{民國年}年收發文」子資料夾
function uploadToDrive_(fileBlob,fileName){
  try{
    var year=new Date().getFullYear()-1911;
    var subFolderName=year+'年收發文';
    var parentFolder=DriveApp.getFolderById(MAIL_FOLDER_ID_);
    var subFolder;
    var folders=parentFolder.getFoldersByName(subFolderName);
    if(folders.hasNext()){
      subFolder=folders.next();
    }else{
      subFolder=parentFolder.createFolder(subFolderName);
      Logger.log('建立子資料夾：'+subFolderName);
    }
    var uploadedFile=subFolder.createFile(fileBlob.setName(fileName));
    Logger.log('Drive 上傳完成：'+fileName+' → '+uploadedFile.getUrl());
    return uploadedFile.getUrl();
  }catch(err){
    Logger.log('uploadToDrive_ error: '+err.message);
    return null;
  }
}

// 用 Claude API 辨識 PDF 文件類別（document type，支援 PDF input）
function classifyDocument_(fileBase64,config){
  var defaultResult={direction:'收文',category:'其他',caseNumber:'',partyName:'',court:'',keyDates:'',summary:''};
  try{
    var promptText='請分析這份法律文件，以 JSON 格式回覆以下欄位（只回 JSON，不加任何說明或 markdown）：\n{"direction":"收文或發文","category":"文件類別（判決書/裁定書/開庭通知/傳票/公文/書狀/起訴書/不起訴處分書/緩起訴處分書/調解通知/其他）","caseNumber":"案號","partyName":"當事人姓名","court":"法院或機關名稱","keyDates":"關鍵日期（如開庭日期、上訴期限等，格式：YYYY-MM-DD）","summary":"文件重點摘要（50字內）"}\n\ndirection 判斷規則：\n- 文件上蓋有法院/地檢/行政機關印信，或有「受文者」標記 → 收文\n- 內容是律師撰寫的書狀格式（如起訴狀、答辯狀、聲請狀）→ 發文\n- 檔名含【王律】搭配機關名稱的函文 → 看內容判斷，機關發給律師=收文\n- 不確定 → 預設收文';
    var payload={
      model:'claude-sonnet-4-20250514',
      max_tokens:1000,
      messages:[{
        role:'user',
        content:[
          {
            type:'document',
            source:{
              type:'base64',
              media_type:'application/pdf',
              data:fileBase64
            }
          },
          {type:'text',text:promptText}
        ]
      }]
    };
    var response=UrlFetchApp.fetch('https://api.anthropic.com/v1/messages',{
      method:'post',
      contentType:'application/json',
      headers:{
        'x-api-key':config.ANTHROPIC_API_KEY,
        'anthropic-version':'2023-06-01',
        'anthropic-beta':'pdfs-2024-09-25'
      },
      payload:JSON.stringify(payload),
      muteHttpExceptions:true
    });
    var code=response.getResponseCode();
    if(code!==200){
      Logger.log('classifyDocument_ API fail: '+code+' '+response.getContentText());
      return defaultResult;
    }
    var result=JSON.parse(response.getContentText());
    var textBlocks=(result.content||[]).filter(function(b){return b.type==='text';});
    if(textBlocks.length===0)return defaultResult;
    var text=textBlocks[0].text.trim();
    // 去除可能的 markdown code fence
    text=text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
    return JSON.parse(text);
  }catch(err){
    Logger.log('classifyDocument_ error: '+err.message);
    return defaultResult;
  }
}

// 用 Claude 動態生成當事人通知訊息（收發文雙模板）
function draftForwardMessageClaude_(classifyResult,config){
  var direction=classifyResult.direction||'收文';
  var category=classifyResult.category||'其他';
  var partyName=classifyResult.partyName||'';
  var caseNumber=classifyResult.caseNumber||'（案號未辨識）';
  var court=classifyResult.court||'';
  var keyDates=classifyResult.keyDates||'';
  var summary=classifyResult.summary||'';

  try{
    var systemPrompt='你是王志文律師事務所的文件轉傳訊息撰寫助手。根據文件辨識結果，擬一則 LINE 訊息供律師轉傳給當事人。\n\n通用規則：\n- 稱呼：[姓][先生/小姐]，不確定性別用「[姓名]您好」\n- 一律用「您」不用「你/妳」\n- 結尾用「我們」代表事務所，不用「我」\n- 禁止寫「如有問題請隨時來電」，正確：「有任何問題跟我們說」\n- 禁止承諾追蹤頻率如「我會第一時間通知」\n- 語氣：禮貌簡潔專業，不用法律術語，重點明確\n- 結尾「謝謝！」\n\n收文模板（事務所收到外部機關文件）：\n\n開庭通知：\n[稱呼]您好\n此為[法院全稱]開庭通知書，通知您如下：\n📌 案號：[案號]\n📅 日期：[民國年月日]\n⏰ 時間：[上午/下午][時間]\n📍 地點：[法院全稱] [法庭]\n再麻煩您屆時提早15分鐘左右抵達與律師會合，謝謝！\n\n判決書/裁定書：\n[稱呼]您好，[判決書/裁定書]今天事務所也收到了，將傳給您。\n[白話結果摘要]\n上訴期限是[日期]。[後續觀察重點]\n您先看一下內容，有任何問題跟我們說。\n\n不起訴/緩起訴處分書：\n[稱呼]您好，處分書今天事務所也收到了，將傳給您。\n[白話說明結果和效果]\n您先看一下內容，有任何問題跟我們說。\n\n一般公文函文：\n[稱呼]您好\n今日收受[機關全稱]的[公文類型]，將公文傳給您參考。\n[簡述重點及當事人需做的事]\n有任何問題跟我們說，謝謝！\n\n調解通知：\n[稱呼]您好\n收到調解通知書了，通知您如下：\n📅 日期：[民國年月日]\n⏰ 時間：[上午/下午][時間]\n📍 地點：[調解委員會全稱]（[地址]）\n當天請記得帶身分證正本影本和印章。\n再麻煩您屆時提早到場，與律師會合，謝謝！\n\n發文模板（事務所向外部機關提出文件）：\n[稱呼]您好\n本所已於[日期]向[法院/機關全稱]提出「[書狀名稱]」。\n[一句話說明書狀重點]\n後續等待回覆，有任何進展會再通知您，謝謝！\n\n重要：收文語氣是「收到了，轉傳給您」；發文語氣是「已提出，等回覆」。絕對不能搞反。';

    var userPrompt='文件辨識結果：\n- 收發文方向：'+direction+'\n- 文件類別：'+category+'\n- 案號：'+caseNumber+'\n- 當事人：'+(partyName||'（未辨識）')+'\n- 法院/機關：'+(court||'（未辨識）')+'\n- 關鍵日期：'+(keyDates||'無')+'\n- 摘要：'+(summary||'（無）')+'\n\n請根據上述資訊和收發文方向，選擇正確模板擬一則 LINE 訊息。只輸出訊息本文，不加任何解釋。';

    var payload={
      model:'claude-sonnet-4-6',
      max_tokens:600,
      system:systemPrompt,
      messages:[{role:'user',content:userPrompt}]
    };
    var response=UrlFetchApp.fetch('https://api.anthropic.com/v1/messages',{
      method:'post',
      contentType:'application/json',
      headers:{'x-api-key':config.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
      payload:JSON.stringify(payload),
      muteHttpExceptions:true
    });
    if(response.getResponseCode()!==200){
      Logger.log('draftForwardMessageClaude_ fail: '+response.getResponseCode());
      return draftForwardMessageFallback_(classifyResult);
    }
    var result=JSON.parse(response.getContentText());
    var textBlocks=(result.content||[]).filter(function(b){return b.type==='text';});
    if(textBlocks.length===0)return draftForwardMessageFallback_(classifyResult);
    return textBlocks[0].text.trim();
  }catch(err){
    Logger.log('draftForwardMessageClaude_ error: '+err.message);
    return draftForwardMessageFallback_(classifyResult);
  }
}

// fallback：Claude 失敗時用的基本模板
function draftForwardMessageFallback_(classifyResult){
  var partyName=classifyResult.partyName||'';
  var caseNumber=classifyResult.caseNumber||'（案號未辨識）';
  var court=classifyResult.court||'相關機關';
  var keyDates=classifyResult.keyDates||'';
  var summary=classifyResult.summary||'';
  var salutation=partyName?partyName.charAt(0)+'先生/小姐，您好：':'您好：';
  var msg=salutation+'\n\n您的案件（'+caseNumber+'）有新文件來自'+court+'。\n\n';
  if(summary)msg+='文件說明：'+summary+'\n\n';
  if(keyDates)msg+='相關日期：'+keyDates+'\n\n';
  msg+='如有任何問題，歡迎與事務所聯繫。\n\n王志文律師 敬上';
  return msg;
}

// 推審核訊息給律師，並暫存草稿（CacheService，6小時）
// 泡泡一：摘要；泡泡二：草稿全文（獨立泡泡方便複製）
function pushReviewToLawyer_(classifyResult,draftMessage,driveFileUrl,config){
  // 暫存供「送出」/「改 xxx」指令使用
  var cache=CacheService.getScriptCache();
  var cacheKey='pending_draft_'+config.LAWYER_LINE_USER_ID;
  cache.put(cacheKey,JSON.stringify({
    classifyResult:classifyResult,
    draftMessage:draftMessage,
    driveFileUrl:driveFileUrl
  }),21600);

  var partyName=classifyResult.partyName||'（未辨識）';
  var caseNumber=classifyResult.caseNumber||'（未辨識）';
  var category=classifyResult.category||'其他';
  var court=classifyResult.court||'（未辨識）';
  var keyDates=classifyResult.keyDates||'無';
  var direction=classifyResult.direction||'收文';

  // 泡泡一：案件摘要 + 操作說明
  var summaryText='📄 收發文處理完成\n方向：'+direction+'\n案件：'+partyName+'（'+caseNumber+'）\n文件：'+category+'\n法院：'+court+'\n關鍵日期：'+keyDates+'\n已存：'+(driveFileUrl||'（上傳失敗）')+'\n\n👉 回覆「送出」→ 取得可複製訊息\n👉 回覆「改 [指示]」→ Claude 重新擬稿';
  pushToLawyer_(summaryText,config);

  // 泡泡二：草稿全文（獨立泡泡，方便直接閱讀與確認）
  pushToLawyer_(draftMessage,config);
}

// 律師回覆「送出」→ 回傳可複製的訊息全文
function handleSendCommand_(replyToken){
  var CONFIG=getConfig_();
  var cache=CacheService.getScriptCache();
  var cacheKey='pending_draft_'+CONFIG.LAWYER_LINE_USER_ID;
  var raw=cache.get(cacheKey);
  if(!raw){
    replyToLine_(replyToken,'❌ 沒有待發訊息（可能已過期，請重新傳送文件）',CONFIG);
    return;
  }
  var data=JSON.parse(raw);
  var copyText='✅ 以下是擬好的訊息，請複製後轉傳給當事人：\n\n'+data.draftMessage;
  replyToLine_(replyToken,copyText,CONFIG);
}

// 律師回覆「改 xxx」→ Claude 重新擬稿後推審核
function handleEditCommand_(replyToken,instruction){
  var CONFIG=getConfig_();
  var cache=CacheService.getScriptCache();
  var cacheKey='pending_draft_'+CONFIG.LAWYER_LINE_USER_ID;
  var raw=cache.get(cacheKey);
  if(!raw){
    replyToLine_(replyToken,'❌ 沒有待修改訊息（可能已過期，請重新傳送文件）',CONFIG);
    return;
  }
  var data=JSON.parse(raw);

  // 用 Claude 重新擬稿
  var newDraft=redraftMessage_(data.draftMessage,instruction,CONFIG);
  if(!newDraft){
    replyToLine_(replyToken,'❌ Claude 改稿失敗，請再試一次',CONFIG);
    return;
  }

  // 更新 cache
  data.draftMessage=newDraft;
  cache.put(cacheKey,JSON.stringify(data),21600);

  var partyName=data.classifyResult.partyName||'（未辨識）';
  var caseNumber=data.classifyResult.caseNumber||'（未辨識）';
  var reviewText='✏️ 已改稿（'+partyName+' / '+caseNumber+'）\n\n擬發給當事人的訊息：\n「'+newDraft+'」\n\n👉 回覆「送出」可複製訊息\n👉 回覆「改 [修改內容]」可再調整';
  replyToLine_(replyToken,reviewText,CONFIG);
}

// Claude 改稿（使用 Sonnet 4.6，與主流程一致）
function redraftMessage_(originalDraft,instruction,config){
  try{
    var payload={
      model:'claude-sonnet-4-6',
      max_tokens:800,
      messages:[{
        role:'user',
        content:'以下是原本擬好的律師事務所訊息：\n\n「'+originalDraft+'」\n\n請根據以下指示修改：'+instruction+'\n\n直接輸出修改後的訊息，不加任何說明或前言。'
      }]
    };
    var response=UrlFetchApp.fetch('https://api.anthropic.com/v1/messages',{
      method:'post',
      contentType:'application/json',
      headers:{'x-api-key':config.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
      payload:JSON.stringify(payload),
      muteHttpExceptions:true
    });
    if(response.getResponseCode()!==200){
      Logger.log('redraftMessage_ fail: '+response.getResponseCode());
      return null;
    }
    var result=JSON.parse(response.getContentText());
    var textBlocks=(result.content||[]).filter(function(b){return b.type==='text';});
    if(textBlocks.length===0)return null;
    return textBlocks[0].text.trim();
  }catch(err){
    Logger.log('redraftMessage_ error: '+err.message);
    return null;
  }
}

// 列出所有 Script Properties（診斷用）
function listAllProps_(){
  return JSON.stringify(PropertiesService.getScriptProperties().getProperties());
}
function listAllProps(){
  return listAllProps_();
}

// 測試：Drive 上傳權限（觸發 Drive OAuth 授權）
function testDriveUpload(){
  try{
    var folder=DriveApp.getFolderById('1B2jUNqxT8fsSCF10Z3dSDjDJHu8cEJ0b');
    Logger.log('✅ Drive 資料夾 OK：'+folder.getName());
    var testFile=folder.createFile('test_drive_auth_ok.txt','Drive 授權測試成功，可刪除此檔。');
    Logger.log('✅ 測試檔案上傳 OK：'+testFile.getUrl());
    testFile.setTrashed(true);
    Logger.log('✅ 測試檔案已清除');
  }catch(err){
    Logger.log('❌ 錯誤：'+err.message);
  }
}

// 測試：模擬收發文流程（不實際下載 LINE 檔案）
function testClassifyDocument(){
  var CONFIG=getConfig_();
  // 用一個最小合法 PDF 的 base64 做測試（1頁空白）
  var minPdfBase64='JVBERi0xLjAKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqIDIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iaiAzIDAgb2JqPDwvVHlwZS9QYWdlL01lZGlhQm94WzAgMCAzIDNdPj5lbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAp0cmFpbGVyPDwvU2l6ZSA0L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKMTkwCiUlRU9G';
  var result=classifyDocument_(minPdfBase64,CONFIG);
  Logger.log('classifyDocument_ result: '+JSON.stringify(result));
}
