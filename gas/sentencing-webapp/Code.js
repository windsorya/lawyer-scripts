function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('量刑分析系統 — 王志文律師')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
