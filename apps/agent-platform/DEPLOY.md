# Deploying to EC2

One dedicated EC2 instance runs the agent and its sandbox containers.

**Why EC2 and not Fargate or Lambda:** the coding worker starts a container
for every command it runs, which needs a Docker daemon. Fargate tasks can't
run Docker, and Lambda can't hold long-running background work. Everything
here is the same `docker compose` setup you run locally.

> These steps have not been run against your AWS account. They are for you to
> run; nothing was created on your behalf.

## 1. What you need

- An Anthropic API key. So far the agent has only run against the stub model.
- On your laptop: the AWS CLI and the Session Manager plugin, used for the
  tunnel in step 4.

## 2. The instance

| Setting        | Value                                         | Why |
| -------------- | --------------------------------------------- | --- |
| AMI            | Ubuntu Server 24.04 LTS                        | current Docker + compose plugin from Docker's own repository; SSM Agent preinstalled |
| Type           | `t4g.medium` (ARM) or `t3.medium`              | 2 vCPU / 4 GiB; sandbox builds (npm, tsc) need memory |
| Disk           | 30 GiB gp3                                     | images, `node_modules`, workspaces |
| Dedicated      | yes                                            | it runs model-written code; keep it away from other workloads |
| Security group | **no inbound rules**                           | you reach it through SSM, nothing listens publicly |
| IAM role       | `AmazonSSMManagedInstanceCore` only            | Session Manager; no other AWS permissions |
| Metadata       | IMDSv2 required, hop limit 1                   | containers can't fetch the instance role's credentials |
| Network        | public subnet with a public IP, or private + NAT | outbound HTTPS to the Anthropic API, Docker Hub, npm, SSM |

**Why no inbound ports:** the HTTP API has no authentication yet. Anyone who
can reach port 3000 could spend your API credits and run code in your
sandboxes.

## 3. Set it up

Open a shell with `aws ssm start-session --target <instance-id>`, then run:

```sh
# Docker Engine and the compose plugin, from Docker's official repository
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# The code. For a private repository, use a read-only fine-grained token or a deploy key.
sudo git clone https://github.com/aheua10/playground.git /opt/playground
cd /opt/playground/apps/agent-platform

# Workspaces, owned by the agent's container user (uid 1000), and the sandbox image
sudo mkdir -p /srv/agent-workspaces && sudo chown 1000:1000 /srv/agent-workspaces
sudo docker pull node:24-slim

# Configuration. The API key stays on the instance, readable by root only.
sudo cp .env.example .env && sudo chmod 600 .env
sudo sed -i 's/^LLM_PROVIDER=.*/LLM_PROVIDER=anthropic/' .env
sudo tee -a .env > /dev/null <<EOF
LOG_FORMAT=json
WORKSPACES_HOST_DIR=/srv/agent-workspaces
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
EOF
sudoedit .env   # add ANTHROPIC_API_KEY=...

# Run it. It restarts with the Docker daemon, so it also survives reboots.
sudo docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d --build
sudo docker compose -f docker-compose.yml -f docker-compose.sandbox.yml logs -f
```

`.env` serves two purposes: compose reads it to fill in `WORKSPACES_HOST_DIR`
and `DOCKER_GID`, and the agent reads it for its configuration.

Optional: to let the worker run `npm install`, add `SANDBOX_NETWORK=bridge`.
That gives sandbox containers outbound network access. They still have no
secrets, and IMDSv2 with hop limit 1 keeps them away from the instance's
credentials.

## 4. Use it from your laptop

```sh
aws ssm start-session --target <instance-id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3000"],"localPortNumber":["3000"]}'

# in another terminal
curl -s -X POST localhost:3000/messages -H 'content-type: application/json' \
  -d '{"conversationId":"demo","message":"Create a TypeScript HTTP server with a /health route"}'
curl -s localhost:3000/conversations/demo/tasks
```

The tunnel ends at `localhost`, which browsers treat as a secure context. A
later voice UI can therefore use the microphone through it without setting up
TLS first.

## 5. Operate

- **Code written by tasks:** `/srv/agent-workspaces/<taskId>/` on the instance.
- **Logs:** `sudo docker compose ... logs -f`. These are JSON lines; sending
  them to CloudWatch is a later step (the `awslogs` driver).
- **Update:** `sudo git pull`, then the same `up -d --build`.
- **Restarts:** conversations and tasks are in memory and lost on restart;
  workspaces persist.
- **Cost:** stop the instance when you're not using it.

## Before exposing it beyond the tunnel

Do these first: authentication on the API, HTTPS (an ALB with an ACM
certificate, or a reverse proxy), and persistent conversation and task
storage.
