"""Model shapes, size limits and keypoint decoding."""

import torch

from gauge_ml import DIAL_INPUT, DIGIT_H, DIGIT_W, N_DIGIT_CLASSES
from gauge_ml.models.dial_keypoint import DialExport, DialKeypointNet, soft_argmax
from gauge_ml.models.digit_cnn import DigitCNN, DigitExport, count_parameters
from gauge_ml.train_dial import keypoint_loss, target_heatmaps
from gauge_ml.train_digit import augment


def test_digit_cnn_is_small_and_outputs_twelve_classes():
    model = DigitCNN().eval()
    assert count_parameters(model) <= 1_000_000
    logits = model(torch.zeros(3, 1, DIGIT_H, DIGIT_W))
    assert logits.shape == (3, N_DIGIT_CLASSES)
    probabilities = DigitExport(model)(torch.rand(3, 1, DIGIT_H, DIGIT_W))
    assert torch.allclose(probabilities.sum(dim=1), torch.ones(3), atol=1e-5)


def test_digit_augmentation_keeps_shape_and_range():
    x = torch.rand(16, 1, DIGIT_H, DIGIT_W)
    out = augment(x, torch.Generator().manual_seed(0))
    assert out.shape == x.shape and float(out.min()) >= 0.0 and float(out.max()) <= 1.0
    assert not torch.equal(out, x)


def test_dial_model_output_shapes_for_both_backbones():
    for backbone in ("mobilenet_v3_small", "resnet18"):
        model = DialKeypointNet(backbone, pretrained=False).eval()
        heatmaps, visibility = model(torch.zeros(2, 3, DIAL_INPUT, DIAL_INPUT))
        assert heatmaps.shape == (2, 5, DIAL_INPUT // 4, DIAL_INPUT // 4)
        assert visibility.shape == (2, 5)
        keypoints, confidence = DialExport(model)(torch.rand(2, 3, DIAL_INPUT, DIAL_INPUT))
        assert keypoints.shape == (2, 5, 2) and confidence.shape == (2, 5)
        assert float(keypoints.min()) >= 0 and float(keypoints.max()) <= DIAL_INPUT
        assert float(confidence.min()) >= 0 and float(confidence.max()) <= 1


def test_soft_argmax_finds_sub_pixel_peaks():
    truth = torch.tensor([[[0.30, 0.70], [0.512, 0.251], [0.9, 0.1], [0.5, 0.5], [0.123, 0.456]]])
    # Sharp log-heatmaps centred on the true positions.
    heatmaps = torch.log(target_heatmaps(truth, 64).reshape(1, 5, 64, 64) + 1e-12)

    decoded = soft_argmax(heatmaps)

    assert torch.allclose(decoded, truth, atol=0.5 / 64)


def test_keypoint_loss_ignores_hidden_keypoints_and_decreases_when_right():
    truth = torch.tensor([[[0.3, 0.7], [0.5, 0.25], [0.9, 0.1], [0.5, 0.5], [0.2, 0.4]]])
    right = torch.log(target_heatmaps(truth, 64).reshape(1, 5, 64, 64) + 1e-12)
    wrong = torch.log(target_heatmaps(1 - truth, 64).reshape(1, 5, 64, 64) + 1e-12)
    visible = torch.ones(1, 5, dtype=torch.bool)
    logits = torch.full((1, 5), 8.0)

    assert keypoint_loss(right, logits, truth, visible) < keypoint_loss(wrong, logits, truth, visible)

    # A wrong heatmap on a hidden keypoint costs nothing in position terms.
    hidden = visible.clone()
    hidden[0, 4] = False
    mixed = right.clone()
    mixed[0, 4] = wrong[0, 4]
    vis_logits = torch.tensor([[8.0, 8.0, 8.0, 8.0, -8.0]])
    assert torch.allclose(
        keypoint_loss(mixed, vis_logits, truth, hidden), keypoint_loss(right, vis_logits, truth, hidden), atol=1e-4
    )


def test_keypoint_confidence_follows_the_sharpness_of_the_heatmap():
    from gauge_ml.models.dial_keypoint import SPREAD_HALF, heatmap_spread, keypoint_confidence

    size = 64
    ys, xs = torch.meshgrid(torch.arange(size) + 0.5, torch.arange(size) + 0.5, indexing="ij")

    def blob(cx: float, cy: float, sigma: float) -> torch.Tensor:
        return torch.exp(-((xs - cx) ** 2 + (ys - cy) ** 2) / (2 * sigma**2))

    sharp = torch.log(blob(20, 30, 1.5) + 1e-12)
    wide = torch.log(blob(20, 30, 4.0) + 1e-12)
    two_peaks = torch.log(blob(12, 30, 1.5) + blob(50, 30, 1.5) + 1e-12)
    heatmaps = torch.stack([sharp, wide, two_peaks])[None]  # (1, 3, 64, 64)
    visible = torch.full((1, 3), 10.0)  # sigmoid close to 1

    spread = heatmap_spread(heatmaps)[0]
    confidence = keypoint_confidence(heatmaps, visible)[0]

    # A target-shaped heatmap (sigma 1.5 per axis) is trusted fully.
    assert abs(float(spread[0]) - 1.5 * 2**0.5) < 0.05 and float(confidence[0]) > 0.99
    # Wide or two-peaked heatmaps fall below the 0.5 at which edge-agent drops a frame.
    assert float(spread[1]) > SPREAD_HALF and float(confidence[1]) < 0.5
    assert float(confidence[2]) == 0.0
    # An invisible keypoint has no confidence however sharp its heatmap.
    assert float(keypoint_confidence(heatmaps, torch.full((1, 3), -10.0))[0, 0]) < 0.01


def test_temperature_sharpens_probabilities_without_changing_the_class():
    torch.manual_seed(0)
    model = DigitCNN().eval()
    x = torch.rand(8, 1, DIGIT_H, DIGIT_W)
    with torch.no_grad():
        plain, sharp = DigitExport(model)(x), DigitExport(model, temperature=0.5)(x)
    assert torch.equal(plain.argmax(dim=1), sharp.argmax(dim=1))
    assert bool((sharp.max(dim=1).values >= plain.max(dim=1).values).all())
    assert torch.allclose(sharp.sum(dim=1), torch.ones(8), atol=1e-5)


def test_fit_temperature_recovers_the_scale_of_over_smoothed_logits():
    from gauge_ml.calibrate_digit import expected_calibration_error, fit_temperature

    torch.manual_seed(0)
    n, classes = 4000, 12
    labels = torch.randint(0, classes, (n,))
    # Calibrated logits (sampled from their own softmax), then flattened by 2.
    true_logits = torch.randn(n, classes) * 3
    labels = torch.distributions.Categorical(logits=true_logits).sample()
    temperature = fit_temperature(true_logits / 2.0, labels)
    assert abs(temperature - 0.5) < 0.05

    confidence = torch.softmax(true_logits, dim=1).max(dim=1).values.numpy()
    correct = (true_logits.argmax(dim=1) == labels).numpy()
    assert expected_calibration_error(confidence, correct) < 0.03
