import { Alert, Button, Spin, Switch, Table, Typography } from "antd";
import { presentRowStatus } from "../public/js/admin.js";

export default function AdminSurface({
  state,
  onToggle,
  onSave,
}: {
  state: any;
  onToggle: (platformId: string, field: string, value: boolean) => void;
  onSave: (platformId: string) => Promise<void>;
}) {
  if (state.view === "loading" || state.view === "idle") {
    return <div className="list-loading" aria-label="站点能力加载中"><Spin /></div>;
  }
  if (state.view === "denied" || state.view === "error") {
    return <Alert type={state.view === "denied" ? "info" : "error"} showIcon title={state.error} />;
  }

  const columns = [
    {
      title: "平台",
      dataIndex: "platformId",
      key: "platformId",
      render: (platformId: string) => <Typography.Text strong>{platformId}</Typography.Text>,
    },
    ...[
      ["captions", "字幕"],
      ["asr", "语音转写"],
      ["enabled", "启用"],
    ].map(([field, label]) => ({
      title: label,
      dataIndex: field,
      key: field,
      render: (value: boolean, row: any) => (
        <Switch
          aria-label={`${row.platformId} ${label}`}
          checked={value}
          disabled={row.saveState === "saving"}
          onChange={(checked) => onToggle(row.platformId, field, checked)}
        />
      ),
    })),
    {
      title: "操作",
      key: "actions",
      render: (_value: unknown, row: any) => (
        <div className="admin-row-actions">
          <Typography.Text type={row.saveState === "error" ? "danger" : "secondary"}>
            {presentRowStatus(row)}
          </Typography.Text>
          <Button
            type="primary"
            autoInsertSpace={false}
            loading={row.saveState === "saving"}
            disabled={row.changedKeys.length === 0}
            onClick={() => void onSave(row.platformId)}
          >
            保存
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="detail-panel admin-panel">
      <Table
        rowKey="platformId"
        columns={columns}
        dataSource={state.rows}
        pagination={false}
        scroll={{ x: 720 }}
      />
    </div>
  );
}
