当前状态
已能用 Crawlee 爬取目标网站（如百度）的页面链接

输出可能仅为 URL 列表

目标
将简单的链接收集升级为 结构化站点功能地图，输出包含：

每个页面上所有可交互元素（链接、按钮、表单等）

每个元素的稳定选择器（用于前端高亮指引）

元素的文本、类型、上下文（导航层级）

输出为 JSON 文件，作为后续 RAG 知识库的原始材料。

执行步骤
第 1 步：改造页面处理逻辑（requestHandler）
不再只打印或收集 URL。

等待页面渲染完成（网络空闲 + 额外延时，确保动态内容加载）。

在浏览器上下文中执行脚本，提取当前页面所有功能元素。

第 2 步：定义元素提取规则
选择器范围（在页面 JS 中执行，非 Node 端）：

a[href]（链接）

button、[role="button"]、[role="link"]、[role="menuitem"]（各类按钮与交互角色）

[onclick]（内联事件元素）

input[type="submit"]、button[type="submit"]

form[action]（表单提交地址）

可选：nav、.sidebar、[role="navigation"] 内的重点链接

第 3 步：过滤无效与危险元素
跳过不可见元素（offsetParent === null 或通过样式判断）。

跳过文本包含“删除、注销、支付、清空、重置”等危险或无关词的元素（避免后续交互）。

仅保留站内链接（同域或符合配置的域名规则）。

第 4 步：为每个元素生成稳定选择器
优先级规则：

如果有 id，使用 #id。

如果有唯一 data-* 属性（如 data-testid），使用属性选择器。

如果有 aria-label 或 aria-labelledby，使用 [aria-label="..."]。

都不满足，则向上遍历父节点，构建一条精简的 CSS 路径（tag + 关键 class，限制 class 数量以保证稳定性）。

第 5 步：提取上下文信息
找到当前元素最近的语义容器：nav、[role="navigation"]、.sidebar、breadcrumb、ul.menu 等。

从容器中提取可见的标题或父级链接文本，作为“上下文”字段（例如：“侧边栏 > 系统管理”）。

第 6 步：存储结构化数据
在全局维护一个收集数组（例如 global.siteMap）。

每处理完一个页面，将结果推入数组，结构包含：

url（当前页面地址）

title（页面标题）

elements（提取的元素列表，每个元素包含 type、text、href、selector、context）

第 7 步：控制抓取边界
保持原有去重逻辑（已访问 URL 不重复）。

配置仅抓取同域名或指定域名的链接（Crawlee 的 enqueueLinks 策略）。

设置 maxRequestsPerCrawl 上限，防止无限爬取。

第 8 步：爬取完成后输出 JSON 文件
在所有请求处理完毕后，将收集到的完整数据写入 sitemap.json。

文件格式示例：

text
{
  "startUrl": "...",
  "totalPages": 数量,
  "pages": [ ... ]
}
第 9 步：简单测试验证
使用一个结构清晰的网站（如 https://crawlee.dev）作为测试目标。

检查输出 JSON 中是否存在多个页面，每个页面是否包含多个元素，选择器是否合理。

确保没有重复条目，没有外部链接混入。

注意事项
所有 DOM 提取逻辑必须运行在 page.evaluate() 内（浏览器上下文），不能使用 Node.js 的 DOM 库。

选择器的生成应在浏览器端完成，直接返回字符串。

保持异步操作，避免阻塞 Crawlee 的事件循环。

爬虫需继续使用 PlaywrightCrawler，确保动态页面兼容。

预期产出
一个 sitemap.json 文件，内容为结构化的网站功能地图，可直接用于下一阶段（LLM 语义增强、向量化入库）。

