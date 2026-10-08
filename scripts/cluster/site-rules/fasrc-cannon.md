---
id: fasrc-cannon
title: FASRC Cannon (Harvard FAS Research Computing)
retrieved: 2026-10-06
page-updated: 2026-08-31 (shown on both pages when retrieved)
sources:
  - https://docs.rc.fas.harvard.edu/kb/running-jobs/
  - https://docs.rc.fas.harvard.edu/kb/fairshare/
---

Site documentation excerpts for submission review. This is dated evidence, not live limits
or an app quota. Native readings (scontrol, sacctmgr associations/QOS, sshare) and the
owner's lab rules are separate sources; native Slurm remains authoritative at submission.
Refresh this file when the pages change (see README.md beside it).

## Interactive development partitions

- test: "dedicated for interactive (foreground / live) work and for testing (interactively)
  code before submitting in batch and scaling." "Small numbers (1 to 5) of serial and
  parallel jobs with small resource requirements (RAM/cores) are permitted." 12-hour maximum
  run time; listed queue maximum of 112 cores and 1000 GB RAM.
- test must not be combined with another partition: "one is not permitted to do
  `#SBATCH -p test,sapphire`".
- gpu_test: listed maximum of 2 jobs, 64 cores, 512 GB RAM, 8 MIG GPUs and a 12-hour run time.
  "Users must request less than 8 CPUs/MIG GPU and 64GB/MIG GPU."

## General limits listed in the documentation

- shared, sapphire, gpu, bigmem, serial_requeue and gpu_requeue list 3-day run limits;
  intermediate 14 days; unrestricted 365 days. Compare the native partition reading.
- Default memory when unspecified: 100 MB, so request memory explicitly.
- Maximum array size 10,000; maximum jobs per user 10,100 (compare native MaxArraySize and
  association/QOS rows).

## Fairshare

- Fairshare is a scheduling-priority mechanism, not a remaining budget; without contention,
  jobs still start with a low score.
- test and gpu_test are exempt from normal fairshare accounting; serial_requeue and
  gpu_requeue are charged at a discount.
- Usage decays with a 3-day half-life; CPU type, memory and GPUs are weighted (TRES billing).
- People with several lab memberships can charge individual jobs to individual accounts;
  choose the account deliberately.

## Review hints

- Prefer test or gpu_test for short development and workflow checks within their job count
  and size; scale up in batch partitions afterwards.
- Compute belongs in an allocation, not on a login node.
