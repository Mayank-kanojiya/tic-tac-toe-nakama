# Deployment Guide: GitHub to AWS EC2

## Step 1: Push to GitHub

```powershell
cd c:\Users\Me\Desktop\Tic_Tac_Toe\tic-tac-toe-nakama
git remote add origin https://github.com/Mayank-kanojiya/tic-tac-toe-nakama.git
git branch -M main
git push -u origin main
```

## Step 2: Set Up AWS EC2 Instance

1. **Launch EC2 Instance** (AWS Console):
   - AMI: Ubuntu 22.04 LTS
   - Instance Type: t2.micro (Free Tier)
   - Security Group Rules:
     - SSH (22): 0.0.0.0/0 (or restrict to your IP)
     - HTTP (80): 0.0.0.0/0
     - HTTPS (443): 0.0.0.0/0
     - Custom TCP 7350-7351 (Nakama): 0.0.0.0/0
     - Custom TCP 3000 (Frontend - if needed): 0.0.0.0/0

2. **Download SSH Key** and save it as `ec2-key.pem`

## Step 3: Set Up EC2 Server

Connect to your instance:
```bash
# On your local machine
ssh -i ec2-key.pem ubuntu@YOUR_EC2_PUBLIC_IP

# Once connected, run:
sudo apt update && sudo apt upgrade -y
sudo apt install -y git docker.io docker-compose

# Add ubuntu user to docker group
sudo usermod -aG docker ubuntu
newgrp docker

# Clone your repository
git clone https://github.com/Mayank-kanojiya/tic-tac-toe-nakama.git
cd tic-tac-toe-nakama

# Start services
docker-compose up -d
```

## Step 4: Configure GitHub Secrets

Go to your GitHub repository → Settings → Secrets and variables → Actions

Add these secrets:
- **EC2_HOST**: Your EC2 public IP (e.g., `35.123.45.67`)
- **EC2_SSH_KEY**: Contents of your `ec2-key.pem` file (entire key, including `-----BEGIN` and `-----END`)

## Step 5: Update Frontend Configuration

Edit `frontend/src/nakama.ts` to use your EC2 IP/domain:
```typescript
const client = new Client();
client.serverKey = "serverkey";
client.host = "YOUR_EC2_PUBLIC_IP"; // Update this
client.port = 7350;
```

## Step 6: Deploy

Now every push to `main` will trigger automatic deployment:
```powershell
git add .
git commit -m "Update deployment config"
git push origin main
```

Monitor the deployment in GitHub Actions → Your Workflow Run

## Useful Commands

```bash
# SSH into your instance
ssh -i ec2-key.pem ubuntu@YOUR_EC2_PUBLIC_IP

# View running containers
docker ps

# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Restart services
docker-compose restart
```

## Frontend Access

- **Nakama Admin Console**: `http://YOUR_EC2_PUBLIC_IP:7350`
- **Nakama gRPC**: `YOUR_EC2_PUBLIC_IP:7351`

## Optional: Set Up Domain

Once stable, buy a domain and point it to your EC2 Elastic IP for a permanent address.
