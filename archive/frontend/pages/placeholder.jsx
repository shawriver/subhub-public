import React from "react";
import { Glass } from "../ui.jsx";

const COPY = {
  nodes: { title: "节点", sub: "节点列表、连通性检查与协议验证", body: "节点页将在 M2 里程碑迁入新界面：节点表、协议徽章、真实协议验证与批量导入都会按新壳子重做。后端接口与数据不变。" },
  subscriptions: { title: "订阅", sub: "订阅集合、个人链接与分流规则", body: "订阅页将在 M2 里程碑迁入新界面：订阅分配、链接配置、规则模板与订阅预览都会按新壳子重做。后端接口与数据不变。" },
  members: { title: "用户", sub: "家人与朋友的订阅、额度与设备", body: "用户页将在 M2 里程碑迁入新界面：用户卡（含设备用量与拉取异常标记）、额度周期与详情抽屉都会按新壳子重做。后端接口与数据不变，规格条目 1 的设备统计会在这里呈现。" },
  tasks: { title: "任务", sub: "同步、探活与后台任务记录", body: "任务页将在 M2 里程碑迁入新界面。后端接口与数据不变。" },
  portal: { title: "用户门户", sub: "家人朋友的订阅自助页", body: "用户门户（/me/…）将在后续里程碑迁入新界面。生产环境的门户不受测试实例影响。" }
};

export default function PlaceholderPage({ page, data }) {
  const copy = COPY[page] || COPY.tasks;
  const counts = data ? {
    nodes: data.nodes.length,
    subscriptions: data.subscriptions.length,
    members: data.members.length,
    tasks: data.tasks.length
  } : {};
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{copy.title}</h1><p className="page-sub">{copy.sub}</p></div>
      </div>
      <Glass className="empty-panel">
        <span className="m2-chip">M2 迁移中</span>
        <p>{copy.body}</p>
        {counts[page] !== undefined && <p className="wide-foot">当前共有 {counts[page]} 条记录，数据完好，可在总览与服务器页查看相关汇总。</p>}
      </Glass>
    </div>
  );
}
