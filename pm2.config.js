export default {
  apps: [
    {
      name: 'pdf-markup',
      script: './server.js',
      // 本番環境では 'cluster' モードで CPU コア数分だけ起動する
      // ※ Socket.IO を使うためセッションはインメモリ管理 → インスタンス 1 つ推奨
      instances: 1,
      exec_mode: 'fork',

      // .env ファイルを自動読み込み
      env_file: '.env',

      // 環境変数（.env で上書き可）
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },

      // クラッシュ時の自動再起動
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,

      // ログ設定
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
