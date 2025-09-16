module.exports = [
  {
    id: '1',
    name: 'Video Processing Workflow',
    nodes: [
      {
        id: 'webhook',
        type: 'n8n-nodes-base.webhook',
        position: [100, 200],
        parameters: {
          path: 'video-processing',
          httpMethod: 'POST',
          authentication: 'headerAuth',
          headerAuth: {
            name: 'Authorization',
            value: `Bearer {{ $env.N8N_WEBHOOK_SECRET }}`
          }
        }
      },
      {
        id: 'download-video',
        type: 'n8n-nodes-base.httpRequest',
        position: [300, 200],
        parameters: {
          url: `https://api.telegram.org/bot{{ $env.TELEGRAM_BOT_TOKEN }}/getFile`,
          method: 'POST',
          json: true,
          body: {
            file_id: '{{ $node["webhook"].json["file_id"] }}'
          }
        }
      },
      {
        id: 'fetch-video',
        type: 'n8n-nodes-base.httpRequest',
        position: [500, 200],
        parameters: {
          url: `https://api.telegram.org/file/bot{{ $env.TELEGRAM_BOT_TOKEN }}/{{ $node["download-video"].json["result"]["file_path"] }}`,
          method: 'GET',
          responseFormat: 'file',
          options: {
            responseSavePath: '/tmp/video-processing/{{ $node["webhook"].json["processing_id"] }}.mp4'
          }
        }
      },
      {
        id: 'process-video',
        type: 'n8n-nodes-base.httpRequest',
        position: [700, 200],
        parameters: {
          url: 'https://video-processing-service.onrender.com/upload-and-process',
          method: 'POST',
          headers: {
            Authorization: `Bearer {{ $env.N8N_WEBHOOK_SECRET }}`
          },
          body: {
            video: {
              value: '{{ $node["fetch-video"].binary.data }}',
              options: {
                filename: '{{ $node["webhook"].json["processing_id"] }}.mp4'
              }
            },
            processing_id: '{{ $node["webhook"].json["processing_id"] }}',
            telegram_id: '{{ $node["webhook"].json["telegram_id"] }}',
            chat_id: '{{ $node["webhook"].json["chat_id"] }}',
            subscription_type: '{{ $node["webhook"].json["subscription_type"] }}',
            callback_url: '{{ $node["webhook"].json["callback_url"] }}'
          },
          sendBinaryData: true
        }
      },
      {
        id: 'store-in-supabase',
        type: 'n8n-nodes-base.supabase',
        position: [900, 200],
        parameters: {
          resource: 'row',
          operation: 'create',
          tableName: 'video_analytics',
          columns: [
            {
              name: 'processing_id',
              value: '{{ $node["webhook"].json["processing_id"] }}'
            },
            {
              name: 'telegram_id',
              value: '{{ $node["webhook"].json["telegram_id"] }}'
            },
            {
              name: 'status',
              value: '{{ $node["process-video"].json["status"] }}'
            },
            {
              name: 'shorts_count',
              value: '{{ $node["process-video"].json["shorts_results"].length }}'
            },
            {
              name: 'thumbnail_url',
              value: '{{ $node["process-video"].json["thumbnail_url"] }}'
            },
            {
              name: 'created_at',
              value: '{{ $now }}'
            }
          ]
        },
        credentials: {
          supabaseApi: {
            url: '{{ $env.SUPABASE_URL }}',
            serviceRoleKey: '{{ $env.SUPABASE_SERVICE_ROLE_KEY }}'
          }
        }
      },
      {
        id: 'callback-to-bot',
        type: 'n8n-nodes-base.httpRequest',
        position: [1100, 200],
        parameters: {
          url: '{{ $node["webhook"].json["callback_url"] }}',
          method: 'POST',
          json: true,
          body: {
            processing_id: '{{ $node["webhook"].json["processing_id"] }}',
            telegram_id: '{{ $node["webhook"].json["telegram_id"] }}',
            chat_id: '{{ $node["webhook"].json["chat_id"] }}',
            status: '{{ $node["process-video"].json["status"] }}',
            shorts_results: '{{ $node["process-video"].json["shorts_results"] }}',
            thumbnail_url: '{{ $node["process-video"].json["thumbnail_url"] }}',
            error: '{{ $node["process-video"].json["error"] || null }}'
          }
        }
      }
    ],
    connections: {
      webhook: {
        main: [{ node: 'download-video', type: 'main', index: 0 }]
      },
      'download-video': {
        main: [{ node: 'fetch-video', type: 'main', index: 0 }]
      },
      'fetch-video': {
        main: [{ node: 'process-video', type: 'main', index: 0 }]
      },
      'process-video': {
        main: [{ node: 'store-in-supabase', type: 'main', index: 0 }]
      },
      'store-in-supabase': {
        main: [{ node: 'callback-to-bot', type: 'main', index: 0 }]
      }
    }
  }
];