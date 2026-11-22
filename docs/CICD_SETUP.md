# MunchMate CI/CD: Setup and Demo Guide

Flow: **Code change -> Git push -> GitHub Actions -> Unit tests + security scans -> Build (zip) -> S3 -> Deploy to EC2 -> Live app**

## Part A: Put the code on GitHub
1. Create a new **public** repository on github.com (public makes CodeQL free). Name it `munchmate`.
2. In the project folder run:
```
git init
git add .
git commit -m "Initial MunchMate with CI/CD"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/munchmate.git
git push -u origin main
```
The first run will fail at the S3 step until Parts B and C are done. That is normal.

## Part B: AWS setup (AWS Console)
1. **S3 bucket:** S3 > Create bucket. Pick a unique name, e.g. `munchmate-builds-yourname`, and note the region. Keep "Block all public access" ON.
2. **EC2 role:** IAM > Roles > Create role > AWS service > EC2. Attach the policy `AmazonSSMManagedInstanceCore`. Then add an inline policy (replace YOUR_BUCKET):
```
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":"arn:aws:s3:::YOUR_BUCKET/builds/*"}]}
```
Name the role `munchmate-ec2-role`.
3. **Launch EC2:** EC2 > Launch instance. Amazon Linux 2023, t2.micro or t3.micro. Under Advanced details set IAM instance profile = `munchmate-ec2-role`, and paste the contents of `scripts/ec2-setup.sh` into **User data**. Security group: allow inbound **HTTP (port 80)** from anywhere. No SSH needed.
4. Wait 3 minutes. In Systems Manager > Fleet Manager the instance should appear as managed. Copy the **Instance ID** (i-0123...) and the **Public IPv4 address**.
5. **GitHub user for the pipeline:** IAM > Users > Create user `github-actions`. Attach this inline policy (replace YOUR_BUCKET and YOUR_INSTANCE_ID):
```
{"Version":"2012-10-17","Statement":[
{"Effect":"Allow","Action":["s3:PutObject","s3:GetObject"],"Resource":"arn:aws:s3:::YOUR_BUCKET/builds/*"},
{"Effect":"Allow","Action":["ssm:SendCommand"],"Resource":["arn:aws:ssm:*::document/AWS-RunShellScript","arn:aws:ec2:*:*:instance/YOUR_INSTANCE_ID"]},
{"Effect":"Allow","Action":["ssm:GetCommandInvocation","ssm:ListCommandInvocations"],"Resource":"*"}]}
```
Then Security credentials > Create access key (use case: third-party service). Save both keys.

*AWS Academy / Learner Lab:* skip steps 2 and 5. Use the existing `LabInstanceProfile` for the EC2 and copy the 3 values from "AWS Details" (access key, secret, session token). They expire every session, so update the GitHub secrets each time.

## Part C: GitHub secrets
Repo > Settings > Secrets and variables > Actions > New repository secret. Add:

| Secret | Value |
|---|---|
| AWS_ACCESS_KEY_ID | from step 5 |
| AWS_SECRET_ACCESS_KEY | from step 5 |
| AWS_SESSION_TOKEN | only for Learner Lab, otherwise leave out |
| AWS_REGION | e.g. us-east-1 |
| S3_BUCKET | your bucket name |
| EC2_INSTANCE_ID | i-0123456789abcdef0 |
| PROD_URL | http://YOUR_EC2_PUBLIC_IP |

Go to the Actions tab > MunchMate CI/CD > Run workflow. All 5 jobs should turn green and http://YOUR_EC2_PUBLIC_IP shows MunchMate with `v1.0.0` in the header.

## Part D: The demo change
1. In `package.json` change `"version": "1.0.0"` to `"1.1.0"`.
2. In `public/index.html` change the headline `Hungry? Just munch it.` to `Hungry? Munch it fresh!`.
3. Run:
```
git add .
git commit -m "v1.1.0: new headline"
git push
```
4. Watch Actions: tests, scans, build, deploy. Refresh the live site: new headline and `v1.1.0`.

To show the pipeline **failing on bad tests**, change `450 * 2 + 180` to `450 * 2 + 181` in `test/app.test.js`, push, and show the red Unit tests job and that nothing is deployed. Then fix it.

## Part E: 2-minute video plan
| Time | Show |
|---|---|
| 0:00 | Live app in browser, old version (v1.0.0) |
| 0:15 | Edit headline and version in VS Code |
| 0:30 | `git add`, `git commit`, `git push` in terminal |
| 0:40 | GitHub Actions tab: workflow starts automatically |
| 0:50 | Open Unit tests job: 9 tests passing. Mention security scans (CodeQL, Gitleaks, npm audit) |
| 1:10 | Build job: zip created. Open S3 console: `builds/build-v1.1.0-N.zip` and `latest.txt` |
| 1:25 | Deploy job log: "Deployed builds/build-v1.1.0..." (fast-forward waiting) |
| 1:40 | Refresh live site: new headline and v1.1.0 |
| 1:55 | Finish |

Tip: record the screen with Win+G (Xbox Game Bar) or OBS, and speed up waiting parts in any video editor.

## Troubleshooting
- **Deploy fails: InvalidInstanceId:** the instance is not registered with SSM. Check the IAM role is attached and wait a few minutes.
- **Deploy fails: Access Denied on S3:** the EC2 role is missing the S3 read policy.
- **Site not loading:** security group must allow port 80. Check `PROD_URL` starts with http:// (not https).
- **Gitleaks or CodeQL error on a private repo:** make the repo public, or remove that job.
- **Learner Lab errors after a while:** the session token expired. Update the 3 AWS secrets.

## What to submit
GitHub repository URL, the 2-minute video, and `.github/workflows/ci-cd.yml`. Bonus (DevSecOps): CodeQL (SAST), Gitleaks (secret scanning) and npm audit (dependency scanning) are already in the workflow.
