# 故事包 · Story packs

在管理台的「故事包」导入 UTF-8 JSON 文件。每个包最多1 MB、200张卡片；新导入的包默认关闭，核对后再启用。重复 ID 不会覆盖已有包，需要先导出备份并移除旧包，或换一个 ID。

Import a UTF-8 JSON file under **故事包** in the console. Each pack supports up to 1 MB and 200 cards. Imported packs start disabled. An existing pack ID cannot be overwritten: export and remove the old pack first, or choose another ID.

```json
{
  "schema_version": 1,
  "pack_id": "small-town",
  "name": "小镇日常",
  "language": "zh-CN",
  "fiction": true,
  "provenance": "原创虚构故事",
  "cards": [
    {
      "id": "bicycle",
      "title": "修自行车的下午",
      "themes": ["小镇", "修车"],
      "search_terms": ["自行车", "雨后"],
      "fiction": true,
      "origin": "original",
      "reveal_levels": {
        "1": "雨停了，我把自行车推到楼下，准备把那条总掉的链子装回去。",
        "2": "邻居端着茶站了一会儿，递给我一双旧手套。他说自己年轻时也总在这儿修车。",
        "3": "车修好了。我绕街骑了一圈，回来时他已经上楼了，门口留着一小瓶链条油。"
      }
    }
  ]
}
```

`pack_id` 和卡片 `id` 使用字母、数字、下划线、点或短横线，最多80字符。包内卡片 ID 不能重复，不同包可以使用相同卡片 ID。`title` 最多160字符；`themes` 与 `search_terms` 各最多30个短词；`reveal_levels` 必须有 `1`、`2`、`3`，每层最多4000字符。

Pack and card IDs use letters, numbers, underscores, dots or hyphens, up to 80 characters. Card IDs must be unique within each pack. Titles support up to 160 characters; each keyword list allows up to 30 short entries. All three reveal levels are required, with up to 4,000 characters each.

`fiction` 必须为 `true`。`origin` 可填 `original`、`licensed` 或 `public-domain`；导入者负责确认内容的使用权，建议在 `provenance` 写明来源和许可。故事包只是数据，不能安装脚本、访问文件、修改权限或创建任务。具体讲法仍由人设和当前对话决定。

`fiction` must be `true`. Set `origin` to `original`, `licensed` or `public-domain`. You are responsible for the content rights; include its source and license in `provenance`. Packs are data only: they cannot install scripts, access files, change permissions or create tasks. The persona and conversation determine how material is told.
