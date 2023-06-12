import { range, fetchResource } from "./helpers.js";
import type { TaskOptions } from "./index.js";

/*
url: 要抓取的链接*
outputDir: 保存到的文件夹*

waitLoad: 使用哪个判据等待页面加载完成
    - "domcontentloaded" 的含义是等整个 HTML 文件都解析完毕, 但图片等外部资源还未加载 (最激进的选项, 不能抓取任何 JS 内容)
    - "load" 的含义是等 HTML 文件中的资源(图片等)全部加载完成, 但这不一定包括 JS 动态加载的内容. 这是默认值
    - "networkidle2" 的含义是等持续 500ms 都没有超过两个网络请求. 所有的网络活动都包括在内
    - "networkidle0" 的含义是等持续 500ms 都没有新的网络请求 (最保守的选项, 不建议使用)
waitTimeout: 在 waitLoad 的基础上额外等待一段固定的时间, 单位为秒
waitSelector: 在前面两个 wait 的基础上额外等待一个元素的出现, 格式为 CSS 选择器. 例如 "#title" 就表示一直等到出现了 id 为 title 的元素后再继续
timeout: 上面每一项等待的超时时间, 单位为秒, 默认 15

preprocess(): 所有等待都结束后, 在页面中执行这个函数. 可用来删除那些不需要的元素
textToCompare(): 获取用于比较页面变动的内容. 这个函数必须返回一个字符串. 仅用于比较, 不会保存
resourcesToCompare(): 获取用于比较页面资源变动的内容. 返回一个字符串数组, 如果包含与上一次不一致的元素, 则会保存该元素所对应的资源
extract(): 获取页面内容. 这个函数必须返回一个字符串
extractResource(id): 下载指定资源. 传入一个来自 resourcesToCompare() 的字符串. 指定为 fetchResource 表示直接下载 URL

interval: 间隔时间. 可以直接指定数字秒数, 例如 5, 或指定随机范围 range(5, 10)

url, outputDir, extract 与 interval 是必填的, 不可省略

---

window.selectTags("img")         返回页面中所有 <img> 元素
window.selectFirst(".red")       返回页面中第一个匹配 .red 这个 CSS 选择器的元素
window.selectAll(".red")         返回页面中所有匹配 .red 这个 CSS 选择器的元素
array.filterContent(/^Hello/)  过滤出 array 数组中所有 textContent 匹配正则表达式 /^Hello/ 的元素
array.removeAll()              从页面中移除数组中所有元素
*/

export const TASKS: TaskOptions[] = [
    /*{
        url: "https://www.timeanddate.com/worldclock/timezone/utc",
        outputDir: "test",
        waitLoad: "networkidle2",
        preprocess() {
            document.querySelectorAll("img").forEach(e => e.remove());
        },
        textToCompare() {
            return document.querySelector("#ct")?.textContent;
        },
        extract() {
            return document.body.innerHTML;
        },
        interval: range(5, 10),
    },*/
    /*{
        url: "http://localhost:5000/",
        outputDir: "test",
        resourcesToCompare() {
            return this.selectTags("img")
                .map((img) => img.src)
                .filter((s) => !!s);
        },
        extract() {
            return this.document.body.innerHTML;
        },
        extractResource: fetchResource,
        interval: 5,
    },*/
    {
        url: "abc",
        outputDir: "Download",
        // prettier-ignore
        preprocess() {
            window.selectTags("span").filterContent(/^已关注/).removeAll();
            window.selectTags("a").filterContent(/^原文评论/).removeAll();
            window.selectTags("span").filterContent(/^原文转发/).removeAll();
            window.selectTags("span").filterContent(/^赞/).removeAll();
            window.selectTags("span").filterContent(/^((今|昨)天 \d{2}:\d{2})|(\d+月+\d+日 \d{2}:\d{2})/).removeAll();
            window.selectTags("span").filterContent(/^((今|昨)天 \d{2}:\d{2})|(\d+分钟前)/).removeAll();
            window.selectTags("a").filterContent(/^私信/).removeAll();
            window.selectTags("a").filterContent(/^资料/).removeAll();
            window.selectTags("a").filterContent(/^操作/).removeAll();
            window.selectTags("a").filterContent(/^加关注/).removeAll();
            window.selectTags("a").filterContent(/^特别关注/).removeAll();
            window.selectTags("a").filterContent(/^送Ta会员/).removeAll();
            window.selectTags("a").filterContent(/^首页/).removeAll();
            window.selectFirst("div.b")?.remove();
            window.selectFirst("div.pm")?.remove();
            window.selectFirst("div.n")?.remove();
            window.selectFirst("div.c.tip")?.remove();
            window.selectFirst("div.cd")?.remove();
            window.selectFirst("div.pmst")?.remove();
            window.selectAll("div.pms").removeAll();
            window.selectAll("div.tc.tip2").removeAll();
            window.selectFirst("#pagelist > form > div")?.remove();
        },
        textToCompare() {
            return document.body.textContent;
        },
        resourcesToCompare() {
            return window
                .selectAll("a > img.ib")
                .map((e) => (e.parentElement as HTMLLinkElement).href)
                .filter((url) => /^https?:\/\/weibo\.cn\/mblog\/pic\/\w+/i.test(url));
        },
        extract() {
            return document.body.innerHTML;
        },
        async extractResource(id) {
            const url = id.replace(/^(https?):\/\/weibo\.cn\/mblog\/(pic)\/(\w+)/i, "$1://weibo.cn/mblog/picAll/$3");
            const html = await window.quickFetch(url).then((r) => r.text());
            const doc = new DOMParser().parseFromString(html, "text/html");
            return await Promise.all(
                Array.prototype.filter
                    .call(doc.getElementsByTagName("a"), (a) => a.textContent === "原图")
                    .map((a) => a.href)
                    .map(async (link) => {
                        const { encodedBuf, url } = await window.fetchResource(link);
                        return {
                            filename: url.substring(url.lastIndexOf("/") + 1),
                            encodedBuf,
                        };
                    })
            );
        },
        interval: range(7, 10),
    },
];
