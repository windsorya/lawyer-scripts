// ===== 進行中任務區塊 =====

const ACTIVE_TASKS_PAGE_ID = '342e22f21ca48199926cd4178fca10ed';

function getActiveTasks() {
  try {
    const notionKey = PropertiesService.getScriptProperties().getProperty('NOTION_API_KEY');
    const res = UrlFetchApp.fetch(
      `https://api.notion.com/v1/blocks/${ACTIVE_TASKS_PAGE_ID}/children?page_size=50`,
      {
        method: 'GET',
        muteHttpExceptions: true,
        headers: {
          'Authorization': 'Bearer ' + notionKey,
          'Notion-Version': '2022-06-28'
        }
      }
    );

    if (res.getResponseCode() !== 200) return [];

    const data = JSON.parse(res.getContentText());
    const tasks = [];

    // 解析頁面內容，找進行中任務
    // 格式：「🔴/🟡/🟢 任務名稱 | 下一步：XXX」
    for (const block of data.results) {
      if (block.type === 'paragraph') {
        const text = block.paragraph.rich_text.map(t => t.plain_text).join('');
        if (text.includes('進行中') || text.includes('🔴') || text.includes('🟡')) {
          // 簡單提取含任務標記的行
          const lines = text.split('\n').filter(l =>
            l.includes('任務：') || l.includes('進度：') || l.includes('下一步：')
          );
          if (lines.length > 0) {
            tasks.push(lines.join(' | '));
          }
        }
      }
    }

    return tasks.slice(0, 3); // 最多顯示3筆
  } catch(e) {
    console.log('getActiveTasks error:', e.message);
    return [];
  }
}

function buildActiveTasksBubble(tasks) {
  if (!tasks || tasks.length === 0) return null;

  const contents = [
    {
      type: 'text',
      text: '📋 進行中任務',
      weight: 'bold',
      size: 'sm',
      color: '#FF6B00'
    }
  ];

  tasks.forEach((task, i) => {
    contents.push({
      type: 'text',
      text: `${i + 1}. ${task.length > 50 ? task.substring(0, 50) + '...' : task}`,
      size: 'xs',
      color: '#333333',
      wrap: true
    });
  });

  contents.push({
    type: 'text',
    text: '→ 開啟 Claude 繼續',
    size: 'xs',
    color: '#999999',
    margin: 'sm'
  });

  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: contents
    }
  };
}
