module.exports = {
  apps: [
    {
      name: "pdf-edit-api",
      script: "./index.js",       // あなたのメインスクリプト名に合わせてください
      instances: "max",           // CPUコア数に応じて最大起動（並列）
      exec_mode: "cluster",       // クラスターモード（マルチプロセス）
      env: {
        NODE_ENV: "production"
      },
      max_memory_restart: "500M", // メモリ上限を超えたら自動再起動（必要に応じて調整）
    }
  ]
}
