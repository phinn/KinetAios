# juejin_publish.py 打补丁说明(2026-09-19 排查两篇静默拒稿后)

## 背景
09-19 06:34/06:35 连发三篇《数字化》系列,《录入:下拉框》上线,另两篇静默死亡:
- 《小公司别学大厂——数据中台,做还是不做》→ **原题重发**(09-07 已发过且在线)= 必死
- 《一把手工程:数字化失败的第一个原因》→ 同批连发 + 系列内容,系统里只剩标题空壳,404

## 掘金拒稿机制(踩坑实录)
- publish API **照样返回 article_id,不报错**——脚本显示 [✅] PUBLISHED 是假象
- 死文章停在 `status=0, audit_status=0, rtime=-62135596800`(空哨兵),公开页 404
- 无任何通知,API 拉不到拒稿原因消息
- 活文章特征:`status=1, audit_status=2`

## 补丁(KinetMarketing/scripts/juejin_publish.py)
`main()` 末尾 `print(f"[✅] PUBLISHED: ...")` 一行,替换为:

```python
    article_id = r['data']['article_id']
    print(f"[✓] publish API 已受理: https://juejin.cn/post/{article_id}")

    # 4) 发布后核验 —— 掘金拒稿是静默的:API 返回成功但审核不过,文章 404,status 永远 0
    print("[*] 90s 后核验审核状态(audit_status=2 才算真上线)...")
    time.sleep(90)
    r = api("/content_api/v1/article/query_list",
            {"cursor": "0", "sort_type": 2, "journal_id": "0", "keyword": ""}, sid)
    for a in (r.get('data') or []):
        if a['article_info'].get('article_id') == article_id:
            i = a['article_info']
            st, au = i.get('status'), i.get('audit_status')
            if st == 1 and au == 2:
                print(f"[✅] 已过审上线: https://juejin.cn/post/{article_id}")
            elif st == 1:
                print(f"[…] 审核中(status=1, audit={au}),稍后再查")
            else:
                print(f"[❌] 疑似被拒(status={st}),公开页会 404。改标题/去重后重发。")
            break
    else:
        print(f"[?] 列表里没找到 {article_id},人工核验")
```

## 发掘金 11 前的 checklist
1. 标题在 juejin.cn 搜一遍,不与已发任何一篇重复(《实测4引擎》《AI Agent杀死流程》《856 commit》《OA表单》《权限》《主数据》《BI》《录入》《小公司》《ECC》)
2. 一次只发一篇,发完等核验通过再考虑下一篇
3. 发后 90s 必须看到 audit_status=2,否则改稿重投
4. 掘金 11 草稿已自查:标题《让 AI 独立交付一个功能:21 轮对话全程复盘,我只说了 6 句话》与现有 13 篇不重复 ✓
