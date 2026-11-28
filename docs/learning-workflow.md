# 学习工作流

*（2026-11 修订。理论层见[学与教的理论](teaching-methodology.md)，本文件描述按文献改进后的完整流程及其依据。提示词是这一流程的实现：`src/agent/prompts/`。）*

一次学习由五段组成：**摸底 → 规划 → 讲授 → 收尾 → 下一次课**。贯穿始终的有两条主线：新知识怎么讲，缺口怎么抓。

## 1. 新知识：先讲清楚，再检验

讲授的单位仍是"一个推理步骤"，每一步之后仍有一道检验题（锁定的决定不变）。变化在于**每一步先分类，再决定由谁先开口**（`teacher/20-teaching.md`）：

| 分类 | 判断依据 | 讲法 |
|---|---|---|
| **全新** | 摸底没有找到这一块的立足点，或引入学习者从未见过的概念、记号、机制 | 直接讲：先说明这一步要解决的问题，平实地陈述事实，再给一道**每一步都写出来、理由可见的完整例题**。不出预测题，不用苏格拉底式提问。讲完再检验 |
| **够得着** | 学习者已掌握构成这一步的各块，之前的作答显示能从这些块推理 | 可以先出预测题，或用苏格拉底式提问让学习者自己迈出这一步，再给出答案 |

- 拿不准时按**全新**处理：多讲一段的代价，远小于让没有基础的人去猜。
- **渐退**：同一段内容上连续两次检验都答得干净且有把握，下一步就开始把"讲"换成"让学习者自己走"。答错则回到直接讲。
- **修复一律直接讲**：先点出答案暴露的错误模型，说明它在哪里不成立，再给出正确的一步及其理由，必要时换一道例题。不用再出一道猜测题来修复。
- 预测题（`teacher/28-predictions.md`）只用于够得着的步骤，并且要对准这一步要确立的那个核心事实。
- 反方证据也要说清楚：先让学习者尝试解题、再讲解（"有效失败"），在不少研究里优于先讲后练（g = 0.36），只是对低年级学生反而更差（Sinha & Kapur 2021）；完整例题若硬加"自我解释"提示，效果反而变差（Barbieri 等 2023）。所以这里不是"永远不用题"，而是：学习者没有基础时先讲，有基础时才让学习者先尝试；例题本身保持干净，说明理由放在讲完之后的检验题里。

**依据**：
- 对初学者，有充分指导的讲授和完整例题优于让他们自己发现（Kirschner、Sweller & Clark 2006；完整例题对数学成绩的平均效应 g = 0.48，Barbieri 等 2023）。
- 同样的指导对已有基础的学习者变得多余，甚至有害，因此指导应随掌握程度逐步撤去（Kalyuga 2007 的知识专长逆转效应；Renkl & Atkinson 2003 的渐退）。
- 预先提问的好处是真实存在的，但很窄：集中在被问到的那一点上（Pan & Carpenter 2023），所以只把它留给学习者够得着、而且对准核心的步骤。

## 2. 课内抓缺口

- **检验题要求说明理由**（`teacher/30-question-principles.md`）：选对了但理由错，算**部分没过**，按没过来修复。依据：让学习者解释推理过程的平均效应 g = 0.55（Bisra 等 2018）。
- **高把握答错**（把握程度 ≥ 70）是最有价值的信号：修复时对比"你的想法默认了什么、在哪里不成立"，并把这一步留到收尾时复测。依据：越有把握的错误，纠正后越容易记住（Butterfield & Metcalfe 2006）；但纠正的效果一周后会下降，所以需要复测（Butler 等 2011）。
- **评分分两步**（`shared/20-question-tools.md`）：先只对照承诺答案判对错，再单独分析推理过程。学习者的语气或坚持不影响判定。

## 3. 收尾：结束条件是"做到了"，不是"觉得懂了"

"目标显然成立"仍是讲授追求的感受，但它只是**必要条件**，不再是结束条件（`teacher/05-method.md`、`teacher/60-closing.md`）。目标节点讲完并检验后，进入收尾，依次做三件事：

1. **复测薄弱步骤**：之前答错的、高把握答错后修复过的、低把握答对的，都换一个表面情境、交错着、隔开一段再测一次。
2. **不看计划图，重建推理链**：用自己的话从基础一路推到目标。
3. **远迁移题**：一道表面情境和课上所有例子都不同的目标题。

没过的步骤直接修复后再测。最后用几行话说明：
- 学习者展示了哪些理解；
- 把握程度与正确率的对照（校准）；
- 哪些缺口留到下次。

**依据**：
- 讲得流畅、听得顺，会提高"觉得学会了"的感受，但不会提高实际学到的东西（Deslauriers 等 2019；Carpenter 等 2013）。
- 对"为什么、怎么运作"这类知识，人最容易高估自己的理解，自己动手解释一遍后，这种高估才会被纠正（Rozenblit & Keil 2002）。
- 学会之后继续检索，一周后的保持率约 80%；一旦答对一次就不再检索，只剩约 35%（Karpicke & Roediger 2008）。
- 不受限地使用 AI 会让学生高估自己的学习（Bastani 等 2025）。

## 4. 下一次课：先冷测遗留缺口

缺口不另建存储，直接从已有的教学会话记录推导（`src/core/open-gaps.ts`）：

- 对每个计划节点，看**最后一次**评分检验的结果：答错、高把握答错、选了"不知道"、低把握答对，都算遗留缺口；之后同一节点上的一次干净通过，就把它关掉。
- 预测题不计入。

工具 `list_open_gaps` 提供给摸底和练习，和 `list_sessions` 受同一个设置开关控制：

- **摸底**（`prober/10-probe-doctrine.md`）：如果新目标依赖的知识里有遗留缺口，先不给提示、换个表面情境直接测。冷测通过就是可以依靠的基础；冷测不过就是确认的缺口，交给老师先补。
- **练习**（`practice/10-doctrine.md`）：开头热身优先选遗留缺口。

**依据**：分多次、每次都检索到答对，比一次学完牢固得多（Rawson & Dunlosky 2022）；隔一段时间、不给提示的作答，才能反映真实的保持情况（延迟判断的准确度远高于当场判断，g = 0.93，Rhodes & Tauber 2011）。

已知限制：
- 只有选择题检验带机器判定。自由作答的检验，只把"不知道"计入缺口，其余答案的判定写在老师的回复里，不会被统计。
- 插件题目不计入。

## 5. 练习中的调整

- 成功率区间从"约 85%、瞄准边缘"改为 **80–95% 的经验区间**。"85% 规则"（Wilson 等 2019）的推导对象是机器学习中的二分类问题，不涉及人类记忆检索；而检索练习在初始成功率较高时收益最大。
- 用到 R3（直接点名命题）及以上提示才完成的检索，不算成功：检索这一步已经交出去了。
- 交错练习按**相似度**选搭配：在目标和容易混淆的近亲命题之间切换。交错练习的收益很依赖材料，类别越相似收益越大（Brunmair & Richter 2019）。

## 参考文献

- Barbieri, Miller-Cotto, Clerjuste & Chawla (2023). A meta-analysis of the worked examples effect on mathematics performance. *Educational Psychology Review*, 35, 11.
- Bastani et al. (2025). Generative AI without guardrails can harm learning: Evidence from high school mathematics. *PNAS*, 122(26).
- Bisra, Liu, Nesbit, Salimi & Winne (2018). Inducing self-explanation: A meta-analysis. *Educational Psychology Review*.
- Brunmair & Richter (2019). Similarity matters: A meta-analysis of interleaved learning and its moderators. *Psychological Bulletin*.
- Butler, Fazio & Marsh (2011). The hypercorrection effect persists over a week, but high-confidence errors return. *Psychonomic Bulletin & Review*.
- Butterfield & Metcalfe (2006). The correction of errors committed with high confidence. *Metacognition and Learning*.
- Carpenter, Wilford, Kornell & Mullaney (2013). Appearances can be deceiving: Instructor fluency increases perceptions of learning without increasing actual learning. *Psychonomic Bulletin & Review*.
- Deslauriers, McCarty, Miller, Callaghan & Kestin (2019). Measuring actual learning versus feeling of learning in response to being actively engaged in the classroom. *PNAS*.
- Kalyuga (2007). Expertise reversal effect and its implications for learner-tailored instruction. *Educational Psychology Review*.
- Karpicke & Roediger (2008). The critical importance of retrieval for learning. *Science*, 319, 966–968.
- Kirschner, Sweller & Clark (2006). Why minimal guidance during instruction does not work. *Educational Psychologist*, 41(2), 75–86.
- Pan & Carpenter (2023). Prequestioning and pretesting effects: A review of empirical research, theoretical perspectives, and implications for educational practice. *Educational Psychology Review*.
- Rawson & Dunlosky (2022). Successive relearning: An underexplored but potent technique for obtaining and maintaining knowledge. *Current Directions in Psychological Science*.
- Renkl & Atkinson (2003). Structuring the transition from example study to problem solving in cognitive skill acquisition: A cognitive load perspective. *Educational Psychologist*, 38, 15–22.
- Sinha & Kapur (2021). When problem solving followed by instruction works: Evidence for productive failure. *Review of Educational Research*.
- Rhodes & Tauber (2011). The influence of delaying judgments of learning on metacognitive accuracy: A meta-analytic review. *Psychological Bulletin*.
- Rozenblit & Keil (2002). The misunderstood limits of folk science: An illusion of explanatory depth. *Cognitive Science*.
- Wilson, Shenhav, Straccia & Cohen (2019). The eighty five percent rule for optimal learning. *Nature Communications*.
