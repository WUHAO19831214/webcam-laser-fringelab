# 科学依据与测量边界

> 本文档说明 FringeLab 这类“光屏 + 消费级摄像头”系统能测什么、不能直接声称测到什么，以及单缝/双缝波长反演的物理模型。具体功能状态以项目 README 和当前界面为准；文中标注为“路线图”的内容不代表已实现。

## 1. 本项目实际测量的信息链

实验中的信息链是：

1. 激光经单缝或双缝后，在光屏上形成随位置变化的**辐照度**；
2. 光屏将入射光散射，向摄像头方向产生**辐亮度**；
3. 镜头、彩色滤光阵列、图像传感器、模数转换和 ISP（Image Signal Processor）把光变成像素数字量；
4. 软件在 ROI 内沿与条纹平行的方向平均，得到一维“空间位置—相对响应”曲线；
5. 条纹位置经空间标定和物理模型转换为波长。

因此，本项目最稳妥的基本输出是：

- 条纹位置、间距和宽度；
- 与当前摄像头设置对应的相对曲线；
- 在已知缝宽或双缝中心距、屏距和空间标定后得到的波长；
- 与这些结果配套的不确定度和质量警告。

## 2. 术语和单位

NIST 对辐射度学与光度学做了清晰区分：辐射度学用功率量描述光学辐射，光度学量则加入人眼视觉响应的光谱加权 [NIST, *Radiometry and Photometry: Review for Vision Optics*](https://www.nist.gov/publications/radiometry-and-photometry-review-vision-optics)。

| 名称 | 符号/单位 | 在本实验中的含义 | 可否直接从普通视频获得 |
| --- | --- | --- | --- |
| 辐照度 irradiance | \(E_e\), W·m\(^{-2}\) | 到达光屏每单位面积的辐射通量 | 不能，需要辐射定标 |
| 辐亮度 radiance | \(L_e\), W·m\(^{-2}\)·sr\(^{-1}\) | 光屏向摄像头方向出射的辐射量 | 不能，需要镜头/传感器/光谱定标 |
| 照度 illuminance | \(E_v\), lux | 按标准明视觉函数加权的光度学量 | **不能**；摄像头 RGB/DN 不是 lux |
| 发光强度 luminous intensity | \(I_v\), cd | 光源每单位立体角的光通量 | 不是本实验对象 |
| 像素数字量 | DN, digital number | 经当前摄像头链路输出的数字码值 | 可获得，但通常已经 ISP 处理 |
| 相对光强 | a.u., arbitrary units | 对背景修正后的相机响应做归一化 | 可获得，必须附带测量条件 |

界面中使用“相对光强（a.u.）”是一种便于教学的操作性名称，它不等同于经计量学定标的绝对辐照度。如果未完成辐射和光谱定标，报告中应写“相对光强（相机响应）”，不应写“照度”、“lux”或“W/m²”。

## 3. 空间几何：精确形式和小角近似

设缝平面到光屏平面的距离为 \(L\)，光屏上某点与中心 \(x_0\) 的有符号距离为

\[
s=x-x_0.
\]

在屏面与中心光轴垂直、\(L\) 沿光轴测量时，

\[
\theta=\arctan\!\left(\frac{s}{L}\right),\qquad
\sin\theta=\frac{s}{\sqrt{L^2+s^2}}.
\]

这是从屏面坐标到角度的精确几何映射。只在 \(|s|\ll L\) 时才有

\[
\sin\theta\approx\tan\theta\approx\theta\approx\frac{s}{L}.
\]

**小角条件与远场条件是两件不同的事。** 前者决定能否使用 \(x/L\) 代替 \(\sin\theta\)，后者决定能否使用 Fraunhofer 衍射模型。软件可以使用精确几何而不必依赖小角近似，但这不会自动消除近场衍射的系统偏差。

## 4. 单缝 Fraunhofer 衍射

对宽度为 \(a\) 的矩形单缝，理想均匀照明且处于 Fraunhofer 区时，强度包络为

\[
I(\theta)=I_0\left(\frac{\sin\beta}{\beta}\right)^2,qquad
\beta=\frac{\pi a\sin\theta}{\lambda},
\]

并定义 \(\lim_{\beta\to0}\sin\beta/\beta=1\)。实际曲线拟合还应允许背景常数、缓慢梯度、幅值与中心偏移，例如

\[
S(x)=B_0+B_1x+A\left(\frac{\sin\beta(x)}{\beta(x)}\right)^2.
\]

[OpenStax 的单缝强度推导](https://openstax.org/books/university-physics-volume-3/pages/4-2-intensity-in-single-slit-diffraction)给出了同样的 \(\mathrm{sinc}^2\) 模型。

### 4.1 暗纹、中央主极大和波长

第 \(n\) 级暗纹满足

\[
a\sin\theta_n=n\lambda,qquad n=\pm1,\pm2,\ldots
\]

精确屏面位置为

\[
x_n=x_0+L\tan\!\left[\arcsin\!\left(\frac{n\lambda}{a}\right)\right].
\]

中央主极大的“第一暗纹到第一暗纹”宽度是

\[
W_0=2L\tan\!\left[\arcsin\!\left(\frac{\lambda}{a}\right)\right]
\approx\frac{2L\lambda}{a}.
\]

因此小角快速公式为

\[
\lambda\approx\frac{aW_0}{2L}.
\]

单缝的次极大不是严格等间距的，其非中心极值条件为 \(\tan\beta=\beta\)。所以，用暗纹位置或完整 \(\mathrm{sinc}^2\) 模型拟合比“把次亮峰当作等间距”更符合物理。

## 5. 有限缝宽的双缝

设每条缝的宽度为 \(a\)，两缝**中心距**为 \(d\)。不要把 \(d\) 与两缝边缘之间的空隙混淆。理想有限宽双缝的强度为

\[
I(\theta)=I_0
\left(\frac{\sin\beta}{\beta}\right)^2
\cos^2\alpha,
\]

\[
\beta=\frac{\pi a\sin\theta}{\lambda},qquad
\alpha=\frac{\pi d\sin\theta}{\lambda}.
\]

即，单缝的 \(\mathrm{sinc}^2\) 包络调制双缝干涉条纹，见 [OpenStax, *Double-Slit Diffraction*](https://openstax.org/books/university-physics-volume-3/pages/4-3-double-slit-diffraction)。

对照明不等、对比度不完美的实际数据，更通用的经验模型可写为

\[
S(x)=B_0+B_1x+A
\left(\frac{\sin\beta}{\beta}\right)^2
\frac{1+V\cos(2\alpha+\phi)}{2},
\]

其中 \(0\le V\le1\) 是可见度参数，\(\phi\) 表示固定相位偏移。这是拟合中的有限参数化，不表示所有光学非理想性都已被消除。

### 5.1 亮纹、暗纹、包络与缺级

双缝干涉因子的理想亮纹方向：

\[
d\sin\theta_m=m\lambda,qquad m=0,\pm1,\pm2,\ldots
\]

双缝干涉因子的理想暗纹方向：

\[
d\sin\theta_h=h\lambda,qquad
h=\pm\tfrac12,\pm\tfrac32,\ldots
\]

单缝包络暗纹方向：

\[
a\sin\theta_n=n\lambda,qquad n\ne0.
\]

当某个干涉亮纹方向同时是包络暗纹方向时，该级会消失，这就是“缺级”。完整乘积曲线的局部峰顶会受包络斜率拉动，因而不必严格落在单独 \(\cos^2\alpha\) 的极大位置。这也是为什么较高精度时应优先使用完整模型或多级回归，而不是只取两个亮峰的差。

### 5.2 条纹间距快速公式

中央附近的小角近似给出

\[
\Delta x\approx\frac{\lambda L}{d},qquad
\lambda\approx\frac{d\,\Delta x}{L}.
\]

在较大角度下，屏面上相邻级次的间距不再严格相等，应转而回归 \(\sin\theta\) 对级次的关系。

## 6. 多级精确回归与可辨识性

对每个已标注的峰或谷，先从空间位置计算

\[
q_i=\sin\theta_i=
\frac{x_i-x_0}{\sqrt{L^2+(x_i-x_0)^2}}.
\]

然后拟合

\[
q_i=c+b,r_i,
\]

其中 \(r_i\) 是级次：单缝暗纹用整数 \(n\)，双缝亮纹用整数 \(m\)，双缝暗纹用半整数 \(h\)。截距 \(c\) 可吸收轻微光轴/入射角偏移，不应无条件强制为零。

单缝暗纹回归有

\[
\lambda=a b,
\]

双缝干涉峰/谷回归有

\[
\lambda=d b.
\]

左右两侧同时拟合，或使用对称半间距

\[
H_n=\frac{x_{+n}-x_{-n}}{2},
\]

可以减小中心位置误差的影响。回归应保留残差、斜率标准误差和级次修改记录；高 \(R^2\) 不代表没有缝尺寸偏差、屏距误差或近场效应。

该问题有一个重要的可辨识性限制：单缝位置主要确定 \(\lambda/a\)，双缝干涉位置主要确定 \(\lambda/d\)。如果 \(a\) 或 \(d\) 没有独立测量，就不能只靠同一幅图样同时求出缝尺寸和波长的绝对值。

## 7. Fraunhofer 远场条件

可用 Fresnel 数做工程性检查：

\[
N_F=\frac{A^2}{\lambda L},
\]

其中 \(A\) 是整个有效孔径的半宽。对单缝可取 \(A=a/2\)；对包含两条宽度 \(a\)、中心距 \(d\) 的双缝，可取外边缘半宽 \(A\approx(d+a)/2\)。

Fraunhofer 条件要求 \(N_F\ll1\)。在教学工具中，可以临时用以下等级做质量提示，但必须把它们标明为经验阈值，而不是物理上的绝对分界：

- \(N_F<0.1\)：通常可作为远场模型的良好起点；
- \(0.1\le N_F<1\)：需警惕系统偏差，应改变 \(L\) 验证结果；
- \(N_F\ge1\)：简单 Fraunhofer 模型通常不适宜，应增大 \(L\) 或使用 Fresnel/角谱模型。

检查时还应确认入射激光近似准直、缝平面和屏面对准，并且 \(L\) 是**缝平面到屏面**的距离，不是激光器到屏面或摄像头到屏面的距离。

## 8. 摄像头 DN 为什么不自动等于光强

消费级摄像头的典型处理链包括：

- 镜头通光率、暗角和离轴响应；
- Bayer 彩色滤光阵列的波长相关响应；
- 积分时间、模拟/数字增益、读出噪声和光子散粒噪声；
- 黑电平修正、去马赛克、白平衡、颜色矩阵、降噪、锐化；
- gamma/色调曲线、局部对比度、自动 HDR 和视频编码。

浏览器 Canvas 中的 RGB 通常是后 ISP 的 8-bit 图像，不是传感器 RAW 电子数。即使看起来像 sRGB，也不应未经验证就假设设备的整条视频链路符合标准 sRGB 曲线。

SPECTACLE 对消费级相机的系统研究表明：RAW 数据通常较线性，JPEG 等处理后数据则并不必然线性；不同设备的偏置、噪声、ISO/增益、平场和 RGB 光谱响应可有显著差别 [Burggraaff et al., 2019, *Optics Express*](https://doi.org/10.1364/OE.27.019075)。[EMVA 1288 Release 4.0](https://www.emva.org/wp-content/uploads/EMVA1288Linear_4.0Release.pdf) 则给出了线性图像传感器的响应、噪声、暗电流、非均匀性和饱和特性的标准化表达框架。

这些问题对不同输出的影响不同：

- **条纹位置**：在响应单调、未饱和、几何稳定时通常较稳健；
- **峰高、峰面积、可见度**：会直接受曝光、增益、gamma、降噪和色彩通道影响；
- **FWHM**：若定义在处理后 DN 的半高上，也会被非线性和背景改变；
- **绝对 lux 或 W/m²**：没有针对设备、镜头、波长、曝光和观察几何的溯源定标时不成立。

## 9. 曝光、饱和、背景和平场

### 9.1 曝光与自动控制

自动曝光（AE）、自动白平衡（AWB）和自动对焦（AF）会让同一个图样在不同帧中获得不同 DN。W3C Image Capture 规范定义了 `getCapabilities()`、`getSettings()` 和 `applyConstraints()` 等接口及曝光/白平衡/对焦能力，但实际支持由浏览器和硬件决定 [W3C MediaStream Image Capture](https://www.w3.org/TR/image-capture/)。设置约束后应重新读取实际设置；“调用没报错”不等于“相机已锁定”。

### 9.2 饱和

当像素达到处理链上限时，真实峰顶被截断为平台。此时：

- 峰高只是下界；
- FWHM 和曲线拟合可被明显偏置；
- 插值不能找回已丢失的峰顶；
- 如果其他暗纹/侧峰位置仍完好，可以只保留降级的位置法结果。

Deb 等人的纸屏 + webcam + ImageJ 单缝波长实验就显示了中央峰饱和后的平顶现象 [Deb, Chakrabarty & Roy Choudhury, 2024](https://doi.org/10.1088/1361-6552/acfebf)。Ramil、López 和 Vincitorio 使用不同曝光时间的数字图像融合来扩大动态范围，并拟合单缝、双缝和圆孔模型 [Ramil, López & Vincitorio, 2007](https://doi.org/10.1119/1.2772288)。多曝光融合只在曝光时间/增益可控、响应已线性化、几何不变且每档均有可信未饱和重叠区时才有物理意义；这属于高级路线图，不应把手机自动 HDR 直接当作科学 HDR。

### 9.3 暗场、环境背景和平场

- **暗场**：在完全遮光、相机设置不变时记录的偏置与暗噪声；
- **环境背景**：激光关闭，但实验室照明和光屏保持实验状态时的图像；
- **平场**：理想均匀照明下记录的空间响应，用于修正镜头暗角、屏幕和像素非均匀性。

完整的线性平场修正形式为

\[
S_{\rm corr}(x,y)=
\frac{S_{\rm lin}(x,y)-D(x,y)}
{[F(x,y)-D(x,y)]/\langle F-D\rangle}.
\]

这个公式的前提是数据已近似线性，平场未饱和且高于噪声底，并且平场与实验的波长和几何条件匹配。单纯用一张白纸图像不会自动构成可溯源的平场。

## 10. 通道选择和一维剖面

红激光不意味着必须无条件使用 R 通道，绿激光也不意味着必须无条件使用 G 通道。选择应综合考虑：

- 饱和像素比例和最长平顶；
- 暗场均值/噪声和有效动态范围；
- 条纹峰谷对比度与信噪比；
- 色彩通道间的串扰与 ISP 处理。

若主颜色通道已饱和，首选是降低曝光/增益或光功率，或使用适当的中性密度滤光片，而不是在不报警的情况下改用漏光较少的其他通道。

一维剖面应从一条与条纹方向对齐的带状 ROI 中得到，沿条纹平行方向对多行/多列平均，而不是只取一行像素。带状平均可降低读出噪声和局部屏幕纹理影响，但对静止的激光散斑（speckle）并不保证通过重复拍摄完全消除。

## 11. 宽度的几种不同定义

“光斑宽度”不是唯一定义，报告必须写明所用定义：

1. 某个峰在扣除局部背景后的 FWHM；
2. 夹住某个亮纹的两个相邻暗纹间距；
3. 双缝相邻亮纹的中心间距；
4. 单缝中央主极大两侧第一暗纹的间距 \(W_0\)；
5. 明确写出阈值的用户定义宽度。

饱和峰不应输出可信 FWHM。严格峰形宽度比较还要求背景、相机响应、对焦、曝光和平滑参数保持一致。

## 12. 不确定度与误差预算

波长结果不应只附一个小数点位数，而应包含输入量的不确定度。主要来源包括：

- 单缝宽 \(a\) 或双缝中心距 \(d\) 的制造公差/独立测量误差；
- 缝平面到屏面距离 \(L\) 的读数与对准误差；
- mm/pixel 空间标定及透视/镜头畸变；
- 峰谷的亚像素定位误差、人工标注和级次错配；
- 近场、入射波前、屏面倾斜和光屏反射非均匀造成的模型偏差；
- 曝光漂移、噪声、饱和和散斑。

例如，小角双缝公式 \(\lambda=d\Delta x/L\) 在输入独立时的一阶相对标准不确定度为

\[
\left(\frac{u_\lambda}{\lambda}\right)^2
=
\left(\frac{u_d}{d}\right)^2
+
\left(\frac{u_{\Delta x}}{\Delta x}\right)^2
+
\left(\frac{u_L}{L}\right)^2.
\]

如果 \(\Delta x=k\Delta p\) 由同一个 mm/pixel 比例 \(k\) 与像素间距 \(\Delta p\) 得到，\(k\) 的误差对所有峰是共同系统项，不能错误地当作每个峰独立噪声而被平均掉。非线性精确几何和相关输入更适合使用参数协方差或 Monte Carlo 传播。对测量不确定度的表达原则可参考 [JCGM 100:2008 (GUM)](https://www.bipm.org/en/doi/10.59161/jcgm100-2008e)，Monte Carlo 传播可参考 [JCGM 101:2008](https://www.bipm.org/documents/20126/2071204/JCGM_101_2008_E.pdf)。

## 13. 实验文献对本项目的启示

- Deb 等人使用纸屏、webcam 和 ImageJ 通过单缝中央主极大宽度测波长，证明低成本组合具有实验可行性，同时也直观展示了饱和平顶问题 [DOI: 10.1088/1361-6552/acfebf](https://doi.org/10.1088/1361-6552/acfebf)。
- Ramil 等人将不同曝光的图像组合，再对完整衍射曲线拟合，说明动态范围和物理拟合同样重要 [DOI: 10.1119/1.2772288](https://doi.org/10.1119/1.2772288)。
- Wagner 等人展示了低成本 webcam 与增强现实可用于教学衍射实验，支持实时可视化的教学价值 [DOI: 10.1119/5.0149766](https://doi.org/10.1119/5.0149766)。
- SPECTACLE 强调消费相机的辐射/光谱响应必须按设备定标，因此项目应把“位置测量”、“校正相对强度”和“绝对辐射测量”分层 [DOI: 10.1364/OE.27.019075](https://doi.org/10.1364/OE.27.019075)。

## 14. 当前科学结论和路线图

本项目可以将普通摄像头变成一个有用的**空间相对响应与条纹位置传感器**，但不能在没有定标时把它宣称为 lux 计或绝对辐照度仪。

核心阶段应优先保证：

- 空间标定可追溯、几何定义正确；
- 相机未饱和，设置尽量稳定；
- 使用带状 ROI 而不是单像素线；
- 优先从多级峰/谷位置反演波长；
- 输出质量状态、残差和不确定度；
- 数据默认本地处理，并保留必要的实验元数据。

高级路线图包括：RAW 输入、摄像头响应函数标定、与实验波长匹配的平场、可验证多曝光 HDR、镜头畸变/四点平面校正、Fresnel 数值模型，以及在完整溯源链下的绝对辐射定标。

## 参考资料

1. [OpenStax: Intensity in Single-Slit Diffraction](https://openstax.org/books/university-physics-volume-3/pages/4-2-intensity-in-single-slit-diffraction)
2. [OpenStax: Double-Slit Diffraction](https://openstax.org/books/university-physics-volume-3/pages/4-3-double-slit-diffraction)
3. [NIST: Radiometry and Photometry](https://www.nist.gov/publications/radiometry-and-photometry-review-vision-optics)
4. [Deb, Chakrabarty & Roy Choudhury: webcam/ImageJ 单缝测波长](https://doi.org/10.1088/1361-6552/acfebf)
5. [Ramil, López & Vincitorio: 数字图像与多曝光衍射分析](https://doi.org/10.1119/1.2772288)
6. [Wagner et al.: 低成本衍射实验与增强现实](https://doi.org/10.1119/5.0149766)
7. [Burggraaff et al.: SPECTACLE 消费相机光谱/辐射定标](https://doi.org/10.1364/OE.27.019075)
8. [EMVA 1288 Release 4.0](https://www.emva.org/wp-content/uploads/EMVA1288Linear_4.0Release.pdf)
9. [W3C MediaStream Image Capture](https://www.w3.org/TR/image-capture/)
10. [JCGM 100:2008, Guide to the Expression of Uncertainty in Measurement](https://www.bipm.org/en/doi/10.59161/jcgm100-2008e)
